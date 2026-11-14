import { analyzeNativeBodyFacts, nativeBodyLinearFlow } from "./native-body-facts.ts";
import type {
	NativeStringBuilderInputs,
	NativeStringBuilderPlan,
} from "./native-string-builders.ts";
import type { NativeFunctionPlan, VmRegisterRepresentation } from "./program-image.ts";
import {
	decodeVmValueOperand,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

export interface NativeStringCodePointSite {
	readonly initializeIp: number;
	readonly stepIp: number;
	readonly register: number;
}

export interface NativeStringCodePointAction {
	readonly observations: ReadonlyArray<NativeStringCodePointSite>;
	readonly operation?:
		| {
				readonly kind: "step" | "switch" | "append";
				readonly site: NativeStringCodePointSite;
		  }
		| {
				readonly kind: "compare";
				readonly site: NativeStringCodePointSite;
				readonly unit: number;
				readonly negated: boolean;
		  };
}

export interface NativeStringCodePointPlan {
	readonly sites: ReadonlyArray<NativeStringCodePointSite>;
	readonly actions: ReadonlyMap<number, NativeStringCodePointAction>;
}

// The boxed register remains the ordinary iterator's value. Only a deferred,
// protector-checked String cursor can activate the scalar, and any other read
// materializes it before ordinary instruction emission or a folded consumer.
export function selectNativeStringCodePoints(
	fn: BytecodeFunction,
	inputs: NativeStringBuilderInputs,
	builders: NativeStringBuilderPlan,
	steps: ReadonlyArray<NativeStringCodePointSite>,
	switches: ReadonlyArray<NonNullable<NativeFunctionPlan["literalSwitches"]>[number]>,
): NativeStringCodePointPlan | undefined {
	const stringSwitches = new Map(
		switches.flatMap((site) =>
			site.kind === "string" &&
			site.cases.every((label) => inputs.stringConstants[label.stringIndex]?.length === 1)
				? [[site.instructionIp, site] as const]
				: [],
		),
	);
	const sites = steps.filter(
		(site) =>
			!inputs.deferredReads.has(site.register) &&
			!inputs.skippedIps.has(site.stepIp) &&
			(inputs.representations[site.register] === "boxed" ||
				inputs.representations[site.register] === "string") &&
			fn.instructions.every(
				(op, ip) =>
					ip === site.stepIp || !vmInstructionWriteRegisters(op).includes(site.register),
			) &&
			[...builders.actions].some(
				([ip, action]) =>
					action.operation?.kind === "append" &&
					!action.operation.ordinary &&
					action.operation.right === site.register &&
					!inputs.skippedIps.has(ip),
			),
	);
	if (sites.length === 0) return undefined;
	const body = analyzeNativeBodyFacts(fn);
	const flow = nativeBodyLinearFlow(fn, body);
	const unitAt = (ip: number, operand: number) => {
		for (let remaining = 32; remaining > 0; remaining--) {
			const value = decodeVmValueOperand(operand);
			if (value.kind === "string") {
				const units = inputs.stringConstants[value.index];
				return units?.length === 1 ? units[0] : undefined;
			}
			if (value.kind !== "register") return undefined;
			const prior = flow.previous(ip);
			if (prior === undefined) return undefined;
			ip = prior;
			const op = fn.instructions[ip]!;
			if (!vmInstructionWriteRegisters(op).includes(operand)) continue;
			if (op.opcode === "CREATE_STRING") {
				const units = inputs.stringConstants[op.stringIndex];
				return units?.length === 1 ? units[0] : undefined;
			}
			if (op.opcode !== "MOVE") return undefined;
			operand = op.src;
		}
		return undefined;
	};
	const actions = new Map<number, NativeStringCodePointAction>();
	const addObservation = (ip: number, site: NativeStringCodePointSite) => {
		const prior = actions.get(ip);
		if (prior?.observations.includes(site)) return;
		actions.set(ip, { ...prior, observations: [...(prior?.observations ?? []), site] });
	};
	for (const site of sites) {
		for (const [ip, op] of fn.instructions.entries()) {
			if (inputs.skippedIps.has(ip)) continue;
			let operation: NativeStringCodePointAction["operation"];
			if (ip === site.stepIp) operation = { kind: "step", site };
			else if (stringSwitches.get(ip)?.selector === site.register)
				operation = { kind: "switch", site };
			else if (
				op.opcode === "BINARY" &&
				(op.operator === "===" || op.operator === "!==") &&
				(op.left === site.register || op.right === site.register)
			) {
				const unit = unitAt(ip, op.left === site.register ? op.right : op.left);
				if (unit !== undefined)
					operation = { kind: "compare", site, unit, negated: op.operator === "!==" };
			} else if (builders.actions.get(ip)?.operation?.kind === "append") {
				const append = builders.actions.get(ip)!.operation!;
				if (
					append.kind === "append" &&
					!append.ordinary &&
					append.right === site.register
				)
					operation = { kind: "append", site };
			}
			if (operation !== undefined) {
				actions.set(ip, { observations: actions.get(ip)?.observations ?? [], operation });
			} else if (
				(inputs.forcedReads.get(ip) ?? vmInstructionReadRegisters(op)).includes(
					site.register,
				)
			) {
				addObservation(ip, site);
			}
		}
		for (const plan of inputs.foldedPlans)
			if (
				plan.claimedIps.some((ip) =>
					vmInstructionReadRegisters(fn.instructions[ip]!).includes(site.register),
				)
			)
				for (const ip of plan.syncIps) addObservation(ip, site);
	}
	return { sites, actions };
}

export function nativeStringCodePointName(site: NativeStringCodePointSite): string {
	return `__string_code_point_${site.stepIp}`;
}

export function materializeNativeStringCodePoint(
	site: NativeStringCodePointSite,
): string {
	const name = nativeStringCodePointName(site);
	return `if (${name}_active && !${name}_synced) { r${site.register} = mal_vm_string_from_code_point(vm, ${name}); ${name}_synced = true; }`;
}

export function renderNativeStringCodePointOperation(
	action: NativeStringCodePointAction | undefined,
	op: BytecodeInstruction,
	ordinary: ReadonlyArray<string>,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): ReadonlyArray<string> {
	const operation = action?.operation;
	if (
		operation === undefined ||
		operation.kind === "append" ||
		operation.kind === "switch"
	)
		return ordinary;
	const { site } = operation;
	const name = nativeStringCodePointName(site);
	if (operation.kind === "compare" && op.opcode === "BINARY") {
		const equal = `${name} ${operation.negated ? "!=" : "=="} ${operation.unit}U`;
		return [
			`if (${name}_active) {`,
			`  r${op.dst} = ${representations[op.dst] === "boolean" ? equal : `mal_value_new_boolean(${equal})`};`,
			`} else {`,
			...ordinary.map((line) => `  ${line}`),
			`}`,
		];
	}
	if (operation.kind !== "step" || op.opcode !== "ITERATOR_STEP") return ordinary;
	const cursor = `__iter_deferred_${site.initializeIp}`;
	return [
		`if (${cursor}.active && ${cursor}.string) {`,
		`  bool __code_point_done_${site.stepIp};`,
		`  mal_vm_deferred_string_code_point_step(${`r${op.iterator}`}, &${cursor}, &${name}, &__code_point_done_${site.stepIp});`,
		`  ${name}_active = !__code_point_done_${site.stepIp};`,
		`  ${name}_synced = false;`,
		`  r${op.valueDst} = MAL_VALUE_UNDEFINED;`,
		`  r${op.doneDst} = ${representations[op.doneDst] === "boolean" ? `__code_point_done_${site.stepIp}` : `mal_value_new_boolean(__code_point_done_${site.stepIp})`};`,
		`} else {`,
		`  ${name}_active = false;`,
		...ordinary.map((line) => `  ${line}`),
		`}`,
	];
}
