import type { VmRegisterRepresentation } from "./program-image.ts";
import {
	vmInstructionUsesRegister,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

type StaticPropertyLoad = Extract<
	BytecodeInstruction,
	{ opcode: "LOAD_PROPERTY_STATIC" }
>;

export type NativePropertyProjectionOperand =
	| { readonly kind: "load"; readonly index: number }
	| { readonly kind: "step"; readonly index: number }
	| { readonly kind: "register"; readonly register: number };

export interface NativePropertyProjectionStep {
	readonly ip: number;
	readonly instruction: Extract<BytecodeInstruction, { opcode: "BINARY" }>;
	readonly left: NativePropertyProjectionOperand;
	readonly right: NativePropertyProjectionOperand;
}

export interface NativePropertyProjectionPlan {
	readonly id: number;
	readonly object: number;
	readonly loads: ReadonlyArray<{
		readonly ip: number;
		readonly instruction: StaticPropertyLoad;
	}>;
	readonly steps: ReadonlyArray<NativePropertyProjectionStep>;
	readonly skippedIps: ReadonlySet<number>;
}

export type NativePropertyProjectionAction =
	| {
			readonly role: "load";
			readonly plan: NativePropertyProjectionPlan;
			readonly index: number;
	  }
	| {
			readonly role: "step";
			readonly plan: NativePropertyProjectionPlan;
			readonly index: number;
	  }
	| { readonly role: "skip"; readonly plan: NativePropertyProjectionPlan };

export interface NativeFastPathLowering {
	readonly propertyProjections: ReadonlyArray<NativePropertyProjectionPlan>;
	readonly propertyProjectionActions: ReadonlyMap<number, NativePropertyProjectionAction>;
	readonly pairedArrayLoops: ReadonlyArray<NativePairedArrayLoopPlan>;
	readonly pairedArrayLoopActions: ReadonlyMap<number, NativePairedArrayLoopAction>;
	readonly constructorInitialization?: NativeConstructorInitializationPlan;
	readonly constructorInitializationActions: ReadonlyMap<
		number,
		NativeConstructorInitializationAction
	>;
}

export interface NativeIndexedLoopElement {
	readonly lengthLoadIp: number;
	readonly elementLoadIp: number;
	readonly object: number;
	readonly key: number;
	readonly result: number;
}

export interface NativePairedArrayLoopPlan {
	readonly id: number;
	readonly lengthLoadIp: number;
	readonly primaryLoadIp: number;
	readonly primaryObject: number;
	readonly secondaryLoadIp: number;
	readonly secondaryObject: number;
	readonly key: number;
}

export type NativePairedArrayLoopAction =
	| { readonly role: "admit"; readonly plan: NativePairedArrayLoopPlan }
	| { readonly role: "load"; readonly plan: NativePairedArrayLoopPlan };

type StaticPropertyStore = Extract<
	BytecodeInstruction,
	{ opcode: "STORE_PROPERTY_STATIC" }
>;

export interface NativeConstructorInitializationPlan {
	readonly id: number;
	readonly stores: ReadonlyArray<{
		readonly ip: number;
		readonly instruction: StaticPropertyStore;
	}>;
}

export interface NativeConstructorInitializationAction {
	readonly plan: NativeConstructorInitializationPlan;
	readonly index: number;
}

const NATIVE_NUMBER_BINARY_OPERATORS = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);

function isNumericRepresentation(representation: VmRegisterRepresentation): boolean {
	return representation === "number" || representation === "int32";
}

function harmlessScalarInstruction(
	instruction: BytecodeInstruction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): boolean {
	return (
		instruction.opcode === "CREATE_NUMBER" ||
		instruction.opcode === "CREATE_F64" ||
		instruction.opcode === "CREATE_BOOLEAN" ||
		(instruction.opcode === "MOVE" &&
			representations[instruction.src] !== "boxed" &&
			representations[instruction.dst] !== "boxed") ||
		(instruction.opcode === "BINARY" &&
			representations[instruction.left] !== "boxed" &&
			representations[instruction.right] !== "boxed" &&
			representations[instruction.dst] !== "boxed") ||
		(instruction.opcode === "UNARY" &&
			representations[instruction.src] !== "boxed" &&
			representations[instruction.dst] !== "boxed")
	);
}

function registerEscapesPlan(
	fn: BytecodeFunction,
	register: number,
	startIp: number,
): boolean {
	for (let ip = startIp; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (vmInstructionUsesRegister(instruction, register)) return true;
		if (vmInstructionWriteRegisters(instruction).includes(register)) return false;
	}
	return false;
}

function lowerPropertyProjection(
	fn: BytecodeFunction,
	firstIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): NativePropertyProjectionPlan | undefined {
	const first = fn.instructions[firstIp];
	const second = fn.instructions[firstIp + 1];
	if (
		first?.opcode !== "LOAD_PROPERTY_STATIC" ||
		second?.opcode !== "LOAD_PROPERTY_STATIC" ||
		first.object !== second.object ||
		first.dst === first.object ||
		representations[first.dst] !== "boxed" ||
		representations[second.dst] !== "boxed" ||
		jumpTargets.has(firstIp + 1) ||
		conflicts(firstIp) ||
		conflicts(firstIp + 1)
	) {
		return undefined;
	}
	const loads: Array<{ ip: number; instruction: StaticPropertyLoad }> = [
		{ ip: firstIp, instruction: first },
		{ ip: firstIp + 1, instruction: second },
	];
	const aliases = new Map<number, NativePropertyProjectionOperand>([
		[first.dst, { kind: "load", index: 0 }],
		[second.dst, { kind: "load", index: 1 }],
	]);
	const produced = new Set<number>([first.dst, second.dst]);
	const usedLoads = new Set<number>();
	const skippedIps = new Set<number>();
	const steps: Array<NativePropertyProjectionStep> = [];
	const limit = Math.min(fn.instructions.length, firstIp + 20);
	for (let ip = firstIp + 2; ip < limit; ip++) {
		if (jumpTargets.has(ip) || conflicts(ip)) break;
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			instruction.object === first.object &&
			instruction.dst !== first.object &&
			representations[instruction.dst] === "boxed" &&
			loads.length < 4
		) {
			const index = loads.length;
			loads.push({ ip, instruction });
			aliases.set(instruction.dst, { kind: "load", index });
			produced.add(instruction.dst);
			continue;
		}
		if (instruction.opcode === "THROW_IF_TDZ" && aliases.has(instruction.src)) {
			skippedIps.add(ip);
			continue;
		}
		if (instruction.opcode === "MOVE" && aliases.has(instruction.src)) {
			if (representations[instruction.dst] !== "boxed") break;
			aliases.set(instruction.dst, aliases.get(instruction.src)!);
			produced.add(instruction.dst);
			skippedIps.add(ip);
			continue;
		}
		if (
			instruction.opcode === "BINARY" &&
			NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator)
		) {
			const operand = (register: number): NativePropertyProjectionOperand | undefined =>
				aliases.get(register) ??
				(isNumericRepresentation(representations[register]!)
					? { kind: "register", register }
					: undefined);
			const left = operand(instruction.left);
			const right = operand(instruction.right);
			const consumesProjection =
				aliases.has(instruction.left) || aliases.has(instruction.right);
			const consumesPrevious =
				steps.length === 0 ||
				(left?.kind === "step" && left.index === steps.length - 1) ||
				(right?.kind === "step" && right.index === steps.length - 1);
			if (
				left === undefined ||
				right === undefined ||
				!consumesProjection ||
				!consumesPrevious
			) {
				break;
			}
			for (const candidate of [left, right]) {
				if (candidate.kind === "load") usedLoads.add(candidate.index);
			}
			const index = steps.length;
			steps.push({ ip, instruction, left, right });
			aliases.set(instruction.dst, { kind: "step", index });
			produced.add(instruction.dst);
			continue;
		}
		const touchesProjection = [...aliases.keys()].some(
			(register) =>
				vmInstructionUsesRegister(instruction, register) ||
				vmInstructionWriteRegisters(instruction).includes(register),
		);
		if (touchesProjection || !harmlessScalarInstruction(instruction, representations))
			break;
	}
	if (steps.length === 0 || loads.some((_load, index) => !usedLoads.has(index))) {
		return undefined;
	}
	const finalRegister = steps.at(-1)!.instruction.dst;
	for (const register of produced) {
		if (register === finalRegister) continue;
		if (registerEscapesPlan(fn, register, steps.at(-1)!.ip + 1)) return undefined;
	}
	return Object.freeze({
		id: firstIp,
		object: first.object,
		loads: Object.freeze(loads.map((load) => Object.freeze(load))),
		steps: Object.freeze(steps.map((step) => Object.freeze(step))),
		skippedIps,
	});
}

function lowerConstructorInitialization(
	fn: BytecodeFunction,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): NativeConstructorInitializationPlan | undefined {
	if (!fn.isClassConstructor || fn.isDerivedConstructor) return undefined;
	const thisAliases = new Set<number>();
	const stores: Array<{ ip: number; instruction: StaticPropertyStore }> = [];
	let thisEscaped = false;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "LOAD_THIS") {
			thisAliases.add(instruction.dst);
			continue;
		}
		if (instruction.opcode === "MOVE") {
			const aliasesThis = thisAliases.has(instruction.src);
			thisAliases.delete(instruction.dst);
			if (aliasesThis) thisAliases.add(instruction.dst);
			continue;
		}
		const usesThis = [...thisAliases].some((register) =>
			vmInstructionUsesRegister(instruction, register),
		);
		const initialization =
			(instruction.opcode === "DEFINE_PROPERTY" ||
				instruction.opcode === "DEFINE_PRIVATE" ||
				instruction.opcode === "INIT_PRIVATE_FIELDS") &&
			thisAliases.has(instruction.object);
		if (
			instruction.opcode === "STORE_PROPERTY_STATIC" &&
			thisAliases.has(instruction.object) &&
			!thisEscaped &&
			!conflicts(ip)
		) {
			stores.push({ ip, instruction });
		} else if (
			usesThis &&
			!initialization &&
			!(instruction.opcode === "THROW_IF_TDZ" && thisAliases.has(instruction.src))
		) {
			thisEscaped = true;
		}
		for (const register of vmInstructionWriteRegisters(instruction)) {
			thisAliases.delete(register);
		}
	}
	if (stores.length < 2 || stores.length > 32) return undefined;
	const firstIp = stores[0]!.ip;
	const lastIp = stores.at(-1)!.ip;
	if (
		stores.some(({ ip }) => ip > firstIp && jumpTargets.has(ip)) ||
		[...jumpTargets].some((ip) => ip > firstIp && ip <= lastIp)
	) {
		return undefined;
	}
	return Object.freeze({
		id: firstIp,
		stores: Object.freeze(stores.map((store) => Object.freeze(store))),
	});
}

function lowerPairedArrayLoops(
	fn: BytecodeFunction,
	indexedLoops: ReadonlyArray<NativeIndexedLoopElement>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): ReadonlyArray<NativePairedArrayLoopPlan> {
	const plans: Array<NativePairedArrayLoopPlan> = [];
	for (const indexed of indexedLoops) {
		const primary = fn.instructions[indexed.elementLoadIp];
		if (
			primary?.opcode !== "LOAD_PROPERTY" ||
			primary.object !== indexed.object ||
			primary.key !== indexed.key ||
			primary.dst !== indexed.result
		)
			continue;
		const limit = Math.min(fn.instructions.length, indexed.elementLoadIp + 8);
		let secondary:
			| {
					readonly ip: number;
					readonly instruction: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY" }>;
			  }
			| undefined;
		for (let ip = indexed.elementLoadIp + 1; ip < limit; ip++) {
			if (jumpTargets.has(ip)) break;
			const instruction = fn.instructions[ip]!;
			if (
				instruction.opcode === "LOAD_PROPERTY" &&
				instruction.key === indexed.key &&
				instruction.object !== indexed.object &&
				!conflicts(ip)
			) {
				secondary = { ip, instruction };
				break;
			}
			if (instruction.opcode !== "THROW_IF_TDZ") break;
		}
		if (secondary === undefined) continue;
		const comparison = fn.instructions[secondary.ip + 1];
		if (
			comparison?.opcode !== "BINARY" ||
			comparison.operator !== "===" ||
			!(
				(comparison.left === indexed.result &&
					comparison.right === secondary.instruction.dst) ||
				(comparison.right === indexed.result &&
					comparison.left === secondary.instruction.dst)
			) ||
			conflicts(secondary.ip + 1)
		)
			continue;
		let secondaryStable = true;
		// The receiver stays live across the backedge, so later register reuse begins after the loop.
		for (let ip = indexed.lengthLoadIp + 1; ip < secondary.ip; ip++) {
			if (
				vmInstructionWriteRegisters(fn.instructions[ip]!).includes(
					secondary.instruction.object,
				)
			) {
				secondaryStable = false;
				break;
			}
		}
		if (!secondaryStable) continue;
		plans.push(
			Object.freeze({
				id: indexed.lengthLoadIp,
				lengthLoadIp: indexed.lengthLoadIp,
				primaryLoadIp: indexed.elementLoadIp,
				primaryObject: indexed.object,
				secondaryLoadIp: secondary.ip,
				secondaryObject: secondary.instruction.object,
				key: indexed.key,
			}),
		);
	}
	return Object.freeze(plans);
}

export function lowerNativeFastPaths(
	fn: BytecodeFunction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
	indexedLoops: ReadonlyArray<NativeIndexedLoopElement> = [],
): NativeFastPathLowering {
	const pairedArrayLoops = lowerPairedArrayLoops(
		fn,
		indexedLoops,
		jumpTargets,
		conflicts,
	);
	const pairedArrayLoopActions = new Map<number, NativePairedArrayLoopAction>();
	for (const plan of pairedArrayLoops) {
		pairedArrayLoopActions.set(plan.lengthLoadIp, { role: "admit", plan });
		pairedArrayLoopActions.set(plan.secondaryLoadIp, { role: "load", plan });
	}
	const propertyProjections: Array<NativePropertyProjectionPlan> = [];
	const propertyProjectionActions = new Map<number, NativePropertyProjectionAction>();
	for (let ip = 0; ip + 1 < fn.instructions.length; ip++) {
		if (propertyProjectionActions.has(ip)) continue;
		const plan = lowerPropertyProjection(
			fn,
			ip,
			representations,
			jumpTargets,
			(candidate) =>
				conflicts(candidate) ||
				pairedArrayLoopActions.has(candidate) ||
				propertyProjectionActions.has(candidate),
		);
		if (plan === undefined) continue;
		propertyProjections.push(plan);
		for (const [index, load] of plan.loads.entries()) {
			propertyProjectionActions.set(load.ip, { role: "load", plan, index });
		}
		for (const [index, step] of plan.steps.entries()) {
			propertyProjectionActions.set(step.ip, { role: "step", plan, index });
		}
		for (const skippedIp of plan.skippedIps) {
			propertyProjectionActions.set(skippedIp, { role: "skip", plan });
		}
	}
	const constructorInitialization = lowerConstructorInitialization(
		fn,
		jumpTargets,
		(candidate) =>
			conflicts(candidate) ||
			pairedArrayLoopActions.has(candidate) ||
			propertyProjectionActions.has(candidate),
	);
	const constructorInitializationActions = new Map<
		number,
		NativeConstructorInitializationAction
	>();
	for (const [index, store] of constructorInitialization?.stores.entries() ?? []) {
		constructorInitializationActions.set(store.ip, {
			plan: constructorInitialization!,
			index,
		});
	}
	return Object.freeze({
		pairedArrayLoops,
		pairedArrayLoopActions,
		propertyProjections: Object.freeze(propertyProjections),
		propertyProjectionActions,
		...(constructorInitialization === undefined ? {} : { constructorInitialization }),
		constructorInitializationActions,
	});
}
