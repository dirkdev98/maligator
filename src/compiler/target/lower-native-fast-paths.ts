import {
	COMPILER_VALUE_KIND_NUMBER,
	compilerBuiltinInputKindsAreValid,
} from "../shared/compiler-value-kinds.ts";
import { selectNativeStringTransform } from "./lower-native-string-transforms.ts";
import type { NativeStringTransformPlan } from "./lower-native-string-transforms.ts";
import { analyzeNativeBodyFacts } from "./native-body-facts.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import {
	MATH_UNARY_NATIVE_CALL,
	MATH_BINARY_OPERATIONS,
	NUMBER_PREDICATES,
} from "./native-scalar-operators.ts";
import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "./program-image.ts";
import {
	decodeVmValueOperand,
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
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
	readonly left: NativePropertyProjectionOperand;
	readonly right: NativePropertyProjectionOperand;
}

export interface NativePropertyProjectionPlan {
	readonly id: number;
	readonly object: number;
	readonly loads: ReadonlyArray<{ readonly ip: number; readonly icIndex: number }>;
	readonly steps: ReadonlyArray<NativePropertyProjectionStep>;
	readonly boxedRegisters: ReadonlyArray<number>;
	readonly skippedIps: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
	readonly terminalStore?: {
		readonly ip: number;
	};
}

type StaticPropertyStore = Extract<
	BytecodeInstruction,
	{ opcode: "STORE_PROPERTY_STATIC" }
>;

export interface NativePropertyNumericUpdatePlan {
	readonly id: number;
	readonly loadIp: number;
	readonly storeIp: number;
	readonly operationIp: number;
	readonly constantIp?: number;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly materializations: ReadonlyArray<{
		readonly ip: number;
		readonly register: number;
		readonly value: "old" | "new";
	}>;
	readonly fallback: "original-instructions";
	readonly operation:
		| { readonly kind: "unary"; readonly operator: "increment" | "decrement" }
		| {
				readonly kind: "binary";
				readonly operator: string;
				readonly propertyIsLeft: boolean;
				readonly right:
					| { readonly kind: "literal"; readonly value: number }
					| { readonly kind: "register"; readonly register: number };
		  };
}

export interface NativePropertyNumericUpdateAction {
	readonly plan: NativePropertyNumericUpdatePlan;
	readonly role: "load" | "constant" | "skip";
	readonly load: StaticPropertyLoad;
	readonly store: StaticPropertyStore;
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
	| { readonly role: "store"; readonly plan: NativePropertyProjectionPlan }
	| { readonly role: "skip"; readonly plan: NativePropertyProjectionPlan };

/** A decline resumes the retained instructions and cannot reuse this admission. */
export interface NativePropertyReadRegionPlan {
	readonly id: number;
	readonly object: number;
	readonly endIp: number;
	readonly loads: ReadonlyArray<{
		readonly ip: number;
		readonly icIndex: number;
	}>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly continuation: "remaining-instructions";
}

export interface NativePropertyReadRegionAction {
	readonly plan: NativePropertyReadRegionPlan;
	readonly index: number;
}

/**
 * One receiver admission covers every number field access of an acyclic,
 * single-entry region. A decline runs the original instructions; an admission
 * computes in locals, writes the stored fields back, and continues at `exitIp`.
 */
export interface NativeNumberRecordRegionPlan {
	readonly id: number;
	readonly object: number;
	readonly exitIp: number;
	/** A stored field's proving row is a store row, which also proves it writable. */
	readonly fields: ReadonlyArray<{
		readonly stringIndex: number;
		readonly icIndex: number;
		readonly stored: boolean;
	}>;
	/** Registers the region can read before writing them, admitted as numbers or Booleans. */
	readonly inputs: ReadonlyArray<number>;
	/** Region results read after the exit. */
	readonly outputs: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
}

export interface NativeIntegerLoopRegionPlan {
	/** The loop header; control reaches it from outside only through `entryIp`'s jump. */
	readonly id: number;
	readonly entryIp: number;
	/** Registers an iteration can read before writing them, admitted as safe integers or Booleans. */
	readonly inputs: ReadonlyArray<number>;
	/** Written inputs, restored from the iteration's start when a guard sends it back to the header. */
	readonly carried: ReadonlyArray<number>;
	readonly exits: ReadonlyArray<{
		readonly targetIp: number;
		/** Written registers read after this exit. */
		readonly outputs: ReadonlyArray<number>;
	}>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
}

export interface NativePropertyReadPairPlan {
	readonly id: number;
	readonly object: number;
	readonly loads: ReadonlyArray<{ readonly ip: number; readonly icIndex: number }>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
}

export interface NativePropertyReadPairAction {
	readonly plan: NativePropertyReadPairPlan;
	readonly role: "first" | "second";
}

export interface NativeArrayPresencePlan {
	readonly regionIndex: number;
	readonly siteIndex: number;
	readonly elementIndex: number;
	readonly membershipIp: number;
	readonly loadIp: number;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
}

export interface NativeArrayPairDestructurePlan {
	readonly regionIndex: number;
	readonly initializeIp: number;
	readonly firstStepIp: number;
	readonly secondStepIp: number;
	readonly closeIp: number;
	readonly continuationIp: number;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-iterator-protocol";
}

export interface NativeLiteralPropertyDefinitionPlan {
	readonly instructionIp: number;
	readonly stringIndex: number;
}

export interface NativeMathCallPlan {
	readonly instructionIp: number;
	readonly operation: string;
	readonly arity: 1 | 2;
	readonly mode: "number" | "guarded-boxed";
}

export const NATIVE_NUMBER_PREDICATE_MODES = [
	"boxed",
	"non-number",
	"int32",
	"number",
] as const;

export interface NativeNumberPredicatePlan {
	readonly instructionIp: number;
	readonly mode: (typeof NATIVE_NUMBER_PREDICATE_MODES)[number];
}

export interface NativeFastPathPlans {
	readonly literalPropertyDefinitions: ReadonlyArray<NativeLiteralPropertyDefinitionPlan>;
	readonly mathCalls: ReadonlyArray<NativeMathCallPlan>;
	readonly numberPredicates: ReadonlyArray<NativeNumberPredicatePlan>;
	readonly stringTransforms: ReadonlyArray<NativeStringTransformPlan>;
	readonly propertyNumericUpdates: ReadonlyArray<NativePropertyNumericUpdatePlan>;
	readonly propertyProjections: ReadonlyArray<NativePropertyProjectionPlan>;
	readonly propertyReadRegions: ReadonlyArray<NativePropertyReadRegionPlan>;
	readonly propertyReadPairs: ReadonlyArray<NativePropertyReadPairPlan>;
	readonly numberRecordRegions: ReadonlyArray<NativeNumberRecordRegionPlan>;
	readonly integerLoopRegions: ReadonlyArray<NativeIntegerLoopRegionPlan>;
	readonly pairedArrayLoops: ReadonlyArray<NativePairedArrayLoopPlan>;
	readonly arrayPresence: ReadonlyArray<NativeArrayPresencePlan>;
	readonly arrayPairDestructure: ReadonlyArray<NativeArrayPairDestructurePlan>;
	readonly constructorInitialization?: NativeConstructorInitializationPlan;
	readonly privateFieldReserve?: NativePrivateFieldReservePlan;
}

export interface NativeFastPathLowering extends NativeFastPathPlans {
	readonly propertyNumericUpdateActions: ReadonlyMap<
		number,
		NativePropertyNumericUpdateAction
	>;
	readonly propertyProjectionActions: ReadonlyMap<number, NativePropertyProjectionAction>;
	readonly propertyReadRegionActions: ReadonlyMap<number, NativePropertyReadRegionAction>;
	readonly propertyReadPairActions: ReadonlyMap<number, NativePropertyReadPairAction>;
	readonly pairedArrayLoopActions: ReadonlyMap<number, NativePairedArrayLoopAction>;
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
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

export type NativePairedArrayLoopAction =
	| { readonly role: "admit"; readonly plan: NativePairedArrayLoopPlan }
	| { readonly role: "load"; readonly plan: NativePairedArrayLoopPlan };

export interface NativeConstructorInitializationPlan {
	readonly id: number;
	readonly stores: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

export interface NativeConstructorInitializationAction {
	readonly plan: NativeConstructorInitializationPlan;
	readonly index: number;
	readonly stores: ReadonlyArray<StaticPropertyStore>;
}

export interface NativePrivateFieldReservePlan {
	readonly id: number;
	readonly count: number;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
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

// Moving later property reads ahead of these instructions must not allocate, poll, or run JavaScript.
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
			representations[instruction.dst] !== "boxed")
	);
}

export const NATIVE_PROPERTY_UPDATE_OPERATORS = [
	"increment",
	"decrement",
	...NATIVE_NUMBER_BINARY_OPERATORS,
];

function registerEscapesPlan(
	fn: BytecodeFunction,
	register: number,
	startIp: number,
	handlerTargets: ReadonlyArray<number | undefined>,
): boolean {
	const pending = [startIp];
	const visited = new Set<number>();
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (ip === fn.instructions.length) continue;
		if (ip < 0 || ip > fn.instructions.length) return true;
		if (visited.has(ip)) continue;
		visited.add(ip);
		const instruction = fn.instructions[ip]!;
		if (vmInstructionUsesRegister(instruction, register)) return true;
		const handlerIp = handlerTargets[ip];
		if (handlerIp !== undefined) pending.push(handlerIp);
		if (
			instruction.opcode === "YIELD" ||
			instruction.opcode === "AWAIT" ||
			instruction.opcode === "GENERATOR_START" ||
			instruction.opcode === "TRY_BEGIN"
		)
			return true;
		if (vmInstructionWriteRegisters(instruction).includes(register)) continue;
		if (instruction.opcode === "JUMP") {
			pending.push(instruction.targetIp);
		} else if (instruction.opcode === "JUMP_IF") {
			pending.push(instruction.targetIp, ip + 1);
		} else if (instruction.opcode !== "RETURN" && instruction.opcode !== "THROW") {
			pending.push(ip + 1);
		}
	}
	return false;
}

function lowerPropertyNumericUpdate(
	fn: BytecodeFunction,
	firstIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
	transparentJumpTargets: ReadonlySet<number>,
	materializeAll: boolean,
	body?: NativeBodyFacts,
): NativePropertyNumericUpdatePlan | undefined {
	const load = fn.instructions[firstIp];
	const numericOutput = (register: number) =>
		representations[register] === "boxed" || representations[register] === "number";
	if (
		load?.opcode !== "LOAD_PROPERTY_STATIC" ||
		load.object === load.dst ||
		representations[load.object] !== "boxed" ||
		!numericOutput(load.dst) ||
		conflicts(firstIp)
	)
		return undefined;
	const aliases = new Map<number, "old" | "new">([[load.dst, "old"]]);
	const outputs: Array<NativePropertyNumericUpdatePlan["materializations"][number]> = [
		{ ip: firstIp, register: load.dst, value: "old" },
	];
	let constantIp: number | undefined;
	let literalRegister: number | undefined;
	let literal: number | undefined;
	let operationIp: number | undefined;
	let operation: NativePropertyNumericUpdatePlan["operation"] | undefined;
	const limit = Math.min(fn.instructions.length, firstIp + 24);
	for (let ip = firstIp + 1; ip < limit; ip++) {
		if ((jumpTargets.has(ip) && !transparentJumpTargets.has(ip)) || conflicts(ip))
			return undefined;
		const op = fn.instructions[ip]!;
		if (op.opcode === "JUMP" && op.targetIp === ip + 1) continue;
		if (op.opcode === "THROW_IF_TDZ" && aliases.has(op.src)) continue;
		if (
			op.opcode === "STORE_PROPERTY_STATIC" &&
			op.object === load.object &&
			aliases.get(op.value) === "new" &&
			operation !== undefined
		) {
			const claimedIps = Array.from({ length: ip - firstIp + 1 }, (_, i) => firstIp + i);
			const externalUses = materializeAll
				? undefined
				: new Set(
						fn.instructions.flatMap((instruction, useIp) =>
							useIp >= firstIp && useIp <= ip
								? []
								: (body?.reads[useIp] ?? vmInstructionReadRegisters(instruction)),
						),
					);
			return Object.freeze({
				id: firstIp,
				loadIp: firstIp,
				storeIp: ip,
				operationIp: operationIp!,
				...(constantIp === undefined ? {} : { constantIp }),
				operation,
				claimedIps,
				borrowedRegisters: borrowedRegisters(fn, claimedIps, body),
				materializations: outputs.filter(
					({ register }) => externalUses === undefined || externalUses.has(register),
				),
				fallback: "original-instructions",
			});
		}
		if (
			!("dst" in op) ||
			op.dst === load.object ||
			(!numericOutput(op.dst) &&
				!(
					(op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64") &&
					representations[op.dst] === "int32"
				))
		)
			return undefined;
		let value: "old" | "new" | undefined;
		if (op.opcode === "MOVE") value = aliases.get(op.src);
		else if (
			op.opcode === "UNARY" &&
			op.operator === "tonumeric" &&
			aliases.get(op.src) === "old" &&
			operation === undefined
		)
			value = "old";
		else if (
			(op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64") &&
			operation === undefined &&
			literalRegister === undefined &&
			!aliases.has(op.dst)
		) {
			constantIp = ip;
			literalRegister = op.dst;
			literal = op.value;
			continue;
		} else if (
			operation === undefined &&
			literalRegister === undefined &&
			op.opcode === "UNARY" &&
			(op.operator === "increment" || op.operator === "decrement") &&
			aliases.get(op.src) === "old"
		) {
			operation = { kind: "unary", operator: op.operator };
			operationIp = ip;
			value = "new";
		} else if (
			operation === undefined &&
			op.opcode === "BINARY" &&
			NATIVE_NUMBER_BINARY_OPERATORS.has(op.operator) &&
			(aliases.get(op.left) === "old" || aliases.get(op.right) === "old")
		) {
			const propertyIsLeft = aliases.get(op.left) === "old";
			const other = propertyIsLeft ? op.right : op.left;
			if (
				aliases.has(other) ||
				other === load.object ||
				(literalRegister !== undefined && other !== literalRegister) ||
				(literalRegister === undefined &&
					representations[other] !== "boxed" &&
					!isNumericRepresentation(representations[other]!))
			)
				return undefined;
			operation = {
				kind: "binary",
				operator: op.operator,
				propertyIsLeft,
				right:
					literalRegister === other
						? { kind: "literal", value: literal! }
						: { kind: "register", register: other },
			};
			operationIp = ip;
			value = "new";
		}
		if (value === undefined || op.dst === literalRegister) return undefined;
		aliases.set(op.dst, value);
		outputs.push({ ip, register: op.dst, value });
	}
	return undefined;
}

function lowerPropertyProjection(
	fn: BytecodeFunction,
	firstIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
	terminalFusion: (
		ip: number,
	) => { readonly id: number; readonly role: "start" | "finish" } | undefined,
	transparentJumpTargets: ReadonlySet<number>,
	handlerTargets: ReadonlyArray<number | undefined>,
	body?: NativeBodyFacts,
): NativePropertyProjectionPlan | undefined {
	const first = fn.instructions[firstIp];
	if (
		first?.opcode !== "LOAD_PROPERTY_STATIC" ||
		first.dst === first.object ||
		representations[first.dst] !== "boxed" ||
		conflicts(firstIp)
	) {
		return undefined;
	}
	const loads: Array<{ ip: number; instruction: StaticPropertyLoad }> = [
		{ ip: firstIp, instruction: first },
	];
	const aliases = new Map<number, NativePropertyProjectionOperand>([
		[first.dst, { kind: "load", index: 0 }],
	]);
	const produced = new Map<number, number>([[first.dst, firstIp]]);
	const usedLoads = new Set<number>();
	const boxedRegisters = new Map<number, number>();
	const skippedIps = new Set<number>();
	const steps: Array<
		NativePropertyProjectionStep & {
			instruction: Extract<BytecodeInstruction, { opcode: "BINARY" }>;
		}
	> = [];
	let receiverClobbered = false;
	const limit = Math.min(fn.instructions.length, firstIp + 20);
	for (let ip = firstIp + 1; ip < limit; ip++) {
		if ((jumpTargets.has(ip) && !transparentJumpTargets.has(ip)) || conflicts(ip)) break;
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "JUMP" && instruction.targetIp === ip + 1) {
			skippedIps.add(ip);
			continue;
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			instruction.object === first.object &&
			!receiverClobbered &&
			representations[instruction.dst] === "boxed" &&
			loads.length < 4
		) {
			const index = loads.length;
			loads.push({ ip, instruction });
			aliases.set(instruction.dst, { kind: "load", index });
			produced.set(instruction.dst, ip);
			receiverClobbered = instruction.dst === first.object;
			continue;
		}
		if (instruction.opcode === "THROW_IF_TDZ" && aliases.has(instruction.src)) {
			skippedIps.add(ip);
			continue;
		}
		if (instruction.opcode === "MOVE" && aliases.has(instruction.src)) {
			if (representations[instruction.dst] !== "boxed") break;
			aliases.set(instruction.dst, aliases.get(instruction.src)!);
			produced.set(instruction.dst, ip);
			skippedIps.add(ip);
			receiverClobbered ||= instruction.dst === first.object;
			continue;
		}
		if (
			instruction.opcode === "BINARY" &&
			NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator)
		) {
			const operand = (register: number): NativePropertyProjectionOperand | undefined =>
				aliases.get(register) ??
				(isNumericRepresentation(representations[register]!) ||
				representations[register] === "boxed"
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
				if (
					candidate.kind === "register" &&
					representations[candidate.register] === "boxed"
				)
					boxedRegisters.set(candidate.register, ip);
			}
			const index = steps.length;
			steps.push({ ip, instruction, left, right });
			aliases.set(instruction.dst, { kind: "step", index });
			produced.set(instruction.dst, ip);
			receiverClobbered ||= instruction.dst === first.object;
			continue;
		}
		const touchesProjection = [...aliases.keys()].some(
			(register) =>
				vmInstructionUsesRegister(instruction, register) ||
				(body?.writes[ip] ?? vmInstructionWriteRegisters(instruction)).includes(register),
		);
		if (
			touchesProjection ||
			(body?.writes[ip] ?? vmInstructionWriteRegisters(instruction)).includes(
				first.object,
			) ||
			!harmlessScalarInstruction(instruction, representations)
		)
			break;
	}
	if (steps.length === 0) return undefined;
	// A fusion start leaves its result unmaterialized for its finish. Rendering
	// publishes a start only from the final step, so every other fused step needs its
	// partner inside this projection.
	for (const [index, step] of steps.entries()) {
		const fusion = terminalFusion(step.ip);
		if (fusion === undefined || (fusion.role === "start" && index === steps.length - 1))
			continue;
		if (
			!steps.some((other) => {
				const partner = terminalFusion(other.ip);
				return (
					other !== step && partner?.id === fusion.id && partner.role !== fusion.role
				);
			})
		)
			return undefined;
	}
	const lastIp = steps.at(-1)!.ip;
	if (loads.length < 2 || loads.some((_load, index) => !usedLoads.has(index))) {
		return undefined;
	}
	for (const [register, consumingIp] of boxedRegisters) {
		for (let ip = firstIp + 1; ip <= lastIp; ip++) {
			if (
				ip !== consumingIp &&
				(body?.writes[ip] ?? vmInstructionWriteRegisters(fn.instructions[ip]!)).includes(
					register,
				)
			)
				return undefined;
		}
	}
	const finalRegister = steps.at(-1)!.instruction.dst;
	for (const [register, producedIp] of produced) {
		if (producedIp > lastIp) continue;
		if (register === finalRegister) continue;
		if (registerEscapesPlan(fn, register, lastIp + 1, handlerTargets)) return undefined;
	}
	const storeIp = lastIp + 1;
	const store = fn.instructions[storeIp];
	const fusedSteps =
		steps.length === 2 &&
		terminalFusion(steps[0]!.ip)?.role === "start" &&
		terminalFusion(lastIp)?.role === "finish" &&
		terminalFusion(steps[0]!.ip)?.id === terminalFusion(lastIp)?.id;
	const standaloneSteps = steps.every((step) => terminalFusion(step.ip) === undefined);
	const terminalStore =
		loads.length === 2 &&
		(fusedSteps || standaloneSteps) &&
		loads[1]!.instruction.dst !== first.object &&
		finalRegister !== first.object &&
		representations[finalRegister] === "boxed" &&
		store?.opcode === "STORE_PROPERTY_STATIC" &&
		store.object === first.object &&
		store.stringIndex === first.stringIndex &&
		store.value === finalRegister &&
		!jumpTargets.has(storeIp) &&
		!conflicts(storeIp) &&
		terminalFusion(storeIp) === undefined &&
		!registerEscapesPlan(fn, finalRegister, storeIp + 1, handlerTargets)
			? { ip: storeIp, instruction: store }
			: undefined;
	const skipped = [...skippedIps].filter((ip) => ip <= lastIp);
	const claimedIps = [
		...loads.filter((load) => load.ip <= lastIp).map((load) => load.ip),
		...steps.map((step) => step.ip),
		...skipped,
		...(terminalStore === undefined ? [] : [terminalStore.ip]),
	].sort((left, right) => left - right);
	return Object.freeze({
		id: firstIp,
		object: first.object,
		loads: loads.map(({ ip, instruction }) => ({ ip, icIndex: instruction.icIndex })),
		steps: steps.map(({ ip, left, right }) => ({ ip, left, right })),
		boxedRegisters: Object.freeze([...boxedRegisters.keys()]),
		skippedIps: skipped,
		claimedIps,
		borrowedRegisters: borrowedRegisters(fn, claimedIps, body),
		fallback: "original-instructions",
		...(terminalStore === undefined ? {} : { terminalStore: { ip: terminalStore.ip } }),
	});
}

const PROPERTY_REGION_COMPARE_OPERATORS = new Set([
	"===",
	"!==",
	"==",
	"!=",
	"<",
	"<=",
	">",
	">=",
]);

const PROPERTY_REGION_UNARY_OPERATORS = new Set([
	"+",
	"-",
	"~",
	"!",
	"tonumeric",
	"increment",
	"decrement",
]);

function propertyReadRegionPureInstruction(
	instruction: BytecodeInstruction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): boolean {
	switch (instruction.opcode) {
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
			return true;
		case "MOVE":
			return (
				representations[instruction.src] === representations[instruction.dst] ||
				(isNumericRepresentation(representations[instruction.src]!) &&
					isNumericRepresentation(representations[instruction.dst]!))
			);
		case "BINARY":
			return (
				isNumericRepresentation(representations[instruction.left]!) &&
				isNumericRepresentation(representations[instruction.right]!) &&
				(isNumericRepresentation(representations[instruction.dst]!) ||
					representations[instruction.dst] === "boolean") &&
				(NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator) ||
					PROPERTY_REGION_COMPARE_OPERATORS.has(instruction.operator))
			);
		case "UNARY":
			return (
				isNumericRepresentation(representations[instruction.src]!) &&
				(isNumericRepresentation(representations[instruction.dst]!) ||
					representations[instruction.dst] === "boolean") &&
				PROPERTY_REGION_UNARY_OPERATORS.has(instruction.operator)
			);
		default:
			return false;
	}
}

function lowerPropertyReadRegion(
	fn: BytecodeFunction,
	firstIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
	body?: NativeBodyFacts,
): NativePropertyReadRegionPlan | undefined {
	const first = fn.instructions[firstIp];
	if (
		first?.opcode !== "LOAD_PROPERTY_STATIC" ||
		first.object === first.dst ||
		representations[first.object] !== "boxed" ||
		representations[first.dst] !== "boxed" ||
		conflicts(firstIp)
	) {
		return undefined;
	}
	const loads = [{ ip: firstIp, instruction: first }];
	const limit = Math.min(fn.instructions.length, firstIp + 24);
	for (let ip = firstIp + 1; ip < limit; ip++) {
		if (jumpTargets.has(ip) || conflicts(ip)) break;
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			instruction.object === first.object &&
			representations[instruction.dst] === "boxed"
		) {
			loads.push({ ip, instruction });
			if (loads.length === 8 || instruction.dst === first.object) break;
			continue;
		}
		// Captured storage is valid only while the receiver is unchanged and no
		// operation can collect, reenter JavaScript, throw, or mutate its layout.
		if (
			(body?.writes[ip] ?? vmInstructionWriteRegisters(instruction)).includes(
				first.object,
			) ||
			!propertyReadRegionPureInstruction(instruction, representations)
		) {
			break;
		}
	}
	if (loads.length < 2 || (loads.length === 2 && loads[1]!.ip === firstIp + 1)) {
		// Preserve the smaller existing adjacent-pair admission.
		return undefined;
	}
	const claimedIps = Array.from(
		{ length: loads.at(-1)!.ip - firstIp + 1 },
		(_, i) => firstIp + i,
	);
	return Object.freeze({
		id: firstIp,
		object: first.object,
		endIp: loads.at(-1)!.ip,
		loads: Object.freeze(
			loads.map(({ ip, instruction }) =>
				Object.freeze({ ip, icIndex: instruction.icIndex }),
			),
		),
		claimedIps,
		borrowedRegisters: borrowedRegisters(fn, claimedIps, body),
		continuation: "remaining-instructions",
	});
}

const NUMBER_RECORD_INSTRUCTION_LIMIT = 96;
const NUMBER_RECORD_FIELD_LIMIT = 16;
const NUMBER_RECORD_UNARY_OPERATORS = new Set([
	"+",
	"-",
	"~",
	"!",
	"tonumeric",
	"increment",
	"decrement",
]);

export type NativeNumberRecordKind = "number" | "boolean";

export interface NativeNumberRecordDataflow {
	/** Every register the region reads or writes holds one local kind throughout. */
	readonly kinds: ReadonlyMap<number, NativeNumberRecordKind>;
	/** Registers some path reads before the region writes them. */
	readonly inputs: ReadonlySet<number>;
	readonly written: ReadonlySet<number>;
	readonly assignedAtExit: ReadonlySet<number>;
	/** Registers every path writes before reaching each visited instruction or terminal. */
	readonly assigned: ReadonlyMap<number, ReadonlySet<number>>;
}

function numberRecordInstruction(
	instruction: BytecodeInstruction,
	object: number,
): boolean {
	switch (instruction.opcode) {
		case "LOAD_PROPERTY_STATIC":
			return instruction.object === object && instruction.dst !== object;
		case "STORE_PROPERTY_STATIC":
			return instruction.object === object && instruction.value !== object;
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
			return instruction.dst !== object;
		case "MOVE":
			return instruction.dst !== object && instruction.src !== object;
		case "BINARY":
			return (
				(NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator) ||
					PROPERTY_REGION_COMPARE_OPERATORS.has(instruction.operator)) &&
				![instruction.dst, instruction.left, instruction.right].includes(object)
			);
		case "UNARY":
			return (
				NUMBER_RECORD_UNARY_OPERATORS.has(instruction.operator) &&
				instruction.dst !== object &&
				instruction.src !== object
			);
		case "JUMP":
			return true;
		case "JUMP_IF":
			return instruction.cond !== object;
		default:
			return false;
	}
}

export function numberRecordSuccessors(
	instruction: BytecodeInstruction,
	ip: number,
): Array<number> {
	if (instruction.opcode === "JUMP") return [instruction.targetIp];
	if (instruction.opcode === "JUMP_IF") return [instruction.targetIp, ip + 1];
	return [ip + 1];
}

/**
 * The instructions reachable from `startIp` before `exitIp`, in topological
 * order, when every path stays acyclic among members until it reaches the exit.
 */
export function numberRecordOrder(
	fn: BytecodeFunction,
	startIp: number,
	exitIp: number,
	member: (ip: number) => boolean,
): ReadonlyArray<number> | undefined {
	const state = new Map<number, "open" | "done">();
	const postorder: Array<number> = [];
	const visit = (ip: number): boolean => {
		if (ip === exitIp) return true;
		const seen = state.get(ip);
		if (seen !== undefined) return seen === "done";
		if (
			ip >= fn.instructions.length ||
			!member(ip) ||
			postorder.length >= NUMBER_RECORD_INSTRUCTION_LIMIT
		)
			return false;
		state.set(ip, "open");
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			if (!visit(successor)) return false;
		state.set(ip, "done");
		postorder.push(ip);
		return true;
	};
	return visit(startIp) ? postorder.reverse() : undefined;
}

function numberRecordInputKind(
	representation: VmRegisterRepresentation | undefined,
): NativeNumberRecordKind | undefined {
	if (representation === "boolean") return "boolean";
	return representation === "number" ||
		representation === "int32" ||
		representation === "boxed"
		? "number"
		: undefined;
}

export function numberRecordDataflow(
	fn: BytecodeFunction,
	order: ReadonlyArray<number>,
	exitIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): NativeNumberRecordDataflow | undefined {
	const kinds = new Map<number, NativeNumberRecordKind>();
	const inputs = new Set<number>();
	const written = new Set<number>();
	const numericReads = new Set<number>();
	const unify = (register: number, kind: NativeNumberRecordKind): boolean => {
		const known = kinds.get(register);
		if (known === undefined) kinds.set(register, kind);
		return known === undefined || known === kind;
	};
	// Topological order visits each instruction after all of its predecessors.
	const assigned = new Map<number, Set<number>>([[order[0]!, new Set()]]);
	const join = (target: number, from: ReadonlySet<number>): void => {
		const prior = assigned.get(target);
		if (prior === undefined) assigned.set(target, new Set(from));
		else for (const register of prior) if (!from.has(register)) prior.delete(register);
	};
	for (const ip of order) {
		const before = assigned.get(ip)!;
		const instruction = fn.instructions[ip]!;
		const read = (register: number, kind?: NativeNumberRecordKind): boolean => {
			if (!before.has(register)) {
				inputs.add(register);
				const input = numberRecordInputKind(representations[register]);
				if (input === undefined || !unify(register, input)) return false;
			}
			if (kind === "number") numericReads.add(register);
			return kind === undefined || kinds.get(register) === kind;
		};
		const write = (
			register: number,
			kind: NativeNumberRecordKind | undefined,
		): boolean => {
			written.add(register);
			return kind !== undefined && unify(register, kind);
		};
		let admitted: boolean;
		switch (instruction.opcode) {
			case "LOAD_PROPERTY_STATIC":
			case "CREATE_NUMBER":
			case "CREATE_F64":
				admitted = write(instruction.dst, "number");
				break;
			case "CREATE_BOOLEAN":
				admitted = write(instruction.dst, "boolean");
				break;
			case "STORE_PROPERTY_STATIC":
				admitted = read(instruction.value, "number");
				break;
			case "MOVE":
				admitted =
					read(instruction.src) && write(instruction.dst, kinds.get(instruction.src));
				break;
			case "BINARY":
				admitted =
					read(instruction.left, "number") &&
					read(instruction.right, "number") &&
					write(
						instruction.dst,
						NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator)
							? "number"
							: "boolean",
					);
				break;
			case "UNARY":
				admitted =
					read(instruction.src, instruction.operator === "!" ? undefined : "number") &&
					write(instruction.dst, instruction.operator === "!" ? "boolean" : "number");
				break;
			case "JUMP_IF":
				admitted = read(instruction.cond);
				break;
			default:
				admitted = instruction.opcode === "JUMP";
		}
		if (!admitted) return undefined;
		const after = new Set(before);
		for (const register of vmInstructionWriteRegisters(instruction)) after.add(register);
		for (const successor of numberRecordSuccessors(instruction, ip))
			join(successor, after);
	}
	// A boxed value only tested or moved is as likely a Boolean, which the guard would always decline.
	for (const register of inputs)
		if (representations[register] === "boxed" && !numericReads.has(register))
			return undefined;
	return {
		kinds,
		inputs,
		written,
		assignedAtExit: assigned.get(exitIp) ?? new Set(),
		assigned,
	};
}

function registersLiveAt(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	entryIp: number,
	registers: ReadonlySet<number>,
): ReadonlyArray<number> {
	const live: Array<number> = [];
	for (const register of registers) {
		const visited = new Uint8Array(fn.instructions.length);
		const pending = [entryIp];
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (ip >= fn.instructions.length || visited[ip] === 1) continue;
			visited[ip] = 1;
			if (body.reads[ip]!.includes(register)) {
				live.push(register);
				break;
			}
			// A throwing instruction may not have written its outputs before the handler runs.
			const handler = body.handlerTargets[ip];
			if (handler !== undefined) pending.push(handler);
			if (body.writes[ip]!.includes(register)) continue;
			const instruction = fn.instructions[ip]!;
			if (instruction.opcode === "JUMP") pending.push(instruction.targetIp);
			else {
				if (instruction.opcode === "JUMP_IF") pending.push(instruction.targetIp);
				if (instruction.opcode !== "RETURN" && instruction.opcode !== "THROW")
					pending.push(ip + 1);
			}
		}
	}
	return live.sort((a, b) => a - b);
}

function numberRecordFields(
	fn: BytecodeFunction,
	order: ReadonlyArray<number>,
): NativeNumberRecordRegionPlan["fields"] | undefined {
	const fields = new Map<
		number,
		{ readonly stringIndex: number; readonly icIndex: number; readonly stored: boolean }
	>();
	let accesses = 0;
	for (const ip of [...order].sort((a, b) => a - b)) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "LOAD_PROPERTY_STATIC") {
			accesses++;
			if (!fields.has(instruction.stringIndex))
				fields.set(instruction.stringIndex, {
					stringIndex: instruction.stringIndex,
					icIndex: instruction.icIndex,
					stored: false,
				});
		} else if (instruction.opcode === "STORE_PROPERTY_STATIC") {
			accesses++;
			if (fields.get(instruction.stringIndex)?.stored !== true)
				fields.set(instruction.stringIndex, {
					stringIndex: instruction.stringIndex,
					icIndex: instruction.icIndex,
					stored: true,
				});
		}
	}
	return accesses < 4 ||
		fields.size > NUMBER_RECORD_FIELD_LIMIT ||
		![...fields.values()].some((field) => field.stored)
		? undefined
		: Object.freeze([...fields.values()]);
}

function admitNumberRecordRegion(
	fn: BytecodeFunction,
	startIp: number,
	order: ReadonlyArray<number>,
	exitIp: number,
	fields: NativeNumberRecordRegionPlan["fields"],
	representations: ReadonlyArray<VmRegisterRepresentation>,
	body: NativeBodyFacts,
): NativeNumberRecordRegionPlan | undefined {
	const members = new Set(order);
	// Control enters only at the start: a later member's predecessors are all members.
	for (const ip of order) {
		if (ip === startIp) continue;
		const previous = fn.instructions[ip - 1];
		if (
			body.externalEntries.has(ip) ||
			body.branchSources.get(ip)?.some((source) => !members.has(source)) ||
			(!members.has(ip - 1) &&
				previous !== undefined &&
				previous.opcode !== "JUMP" &&
				previous.opcode !== "RETURN" &&
				previous.opcode !== "THROW")
		)
			return undefined;
	}
	const flow = numberRecordDataflow(fn, order, exitIp, representations);
	if (flow === undefined) return undefined;
	const outputs = registersLiveAt(fn, body, exitIp, flow.written);
	const inputs = new Set(flow.inputs);
	for (const register of outputs) {
		const representation = representations[register];
		const kind = flow.kinds.get(register);
		if (
			kind === "number"
				? representation !== "number" &&
					representation !== "int32" &&
					representation !== "boxed"
				: representation !== "boolean" && representation !== "boxed"
		)
			return undefined;
		// A path that skips the write leaves the output with the value it entered with.
		if (!flow.assignedAtExit.has(register)) {
			if (numberRecordInputKind(representation) !== kind) return undefined;
			inputs.add(register);
		}
	}
	const claimedIps = [...order].sort((a, b) => a - b);
	return Object.freeze({
		id: startIp,
		object: (fn.instructions[startIp] as StaticPropertyLoad).object,
		exitIp,
		fields,
		inputs: Object.freeze([...inputs].sort((a, b) => a - b)),
		outputs: Object.freeze(outputs),
		claimedIps,
		borrowedRegisters: borrowedRegisters(fn, claimedIps, body),
		fallback: "original-instructions",
	});
}

function lowerNumberRecordRegion(
	fn: BytecodeFunction,
	startIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	body: NativeBodyFacts,
	conflicts: (ip: number) => boolean,
): NativeNumberRecordRegionPlan | undefined {
	const first = fn.instructions[startIp];
	if (
		first?.opcode !== "LOAD_PROPERTY_STATIC" ||
		representations[first.object] !== "boxed"
	)
		return undefined;
	const admissible = (ip: number) =>
		!conflicts(ip) && numberRecordInstruction(fn.instructions[ip]!, first.object);
	const closure = new Set<number>();
	const exits = new Set<number>();
	const pending = [startIp];
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (closure.has(ip) || exits.has(ip)) continue;
		if (ip >= fn.instructions.length) return undefined;
		if (!admissible(ip) || closure.size >= NUMBER_RECORD_INSTRUCTION_LIMIT) {
			exits.add(ip);
			continue;
		}
		closure.add(ip);
		pending.push(...numberRecordSuccessors(fn.instructions[ip]!, ip));
	}
	if (numberRecordFields(fn, [...closure]) === undefined) return undefined;
	// Any member or closure exit can serve as the single exit of a smaller region.
	const candidates: Array<{
		readonly order: ReadonlyArray<number>;
		readonly exitIp: number;
		readonly fields: NativeNumberRecordRegionPlan["fields"];
	}> = [];
	for (const exitIp of [...closure, ...exits]) {
		if (exitIp === startIp || exitIp >= fn.instructions.length) continue;
		const order = numberRecordOrder(fn, startIp, exitIp, (ip) => closure.has(ip));
		const fields = order === undefined ? undefined : numberRecordFields(fn, order);
		if (order !== undefined && fields !== undefined)
			candidates.push({ order, exitIp, fields });
	}
	candidates.sort((a, b) => b.order.length - a.order.length || a.exitIp - b.exitIp);
	for (const { order, exitIp, fields } of candidates) {
		const plan = admitNumberRecordRegion(
			fn,
			startIp,
			order,
			exitIp,
			fields,
			representations,
			body,
		);
		if (plan !== undefined) return plan;
	}
	return undefined;
}

const INTEGER_LOOP_INSTRUCTION_LIMIT = 64;
// Their double lowering converts to int32 or divides, which a safe-integer iteration avoids.
const INTEGER_LOOP_PROFITABLE_OPERATORS = new Set([
	"/",
	"%",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);

function integerLoopInstruction(instruction: BytecodeInstruction): boolean {
	switch (instruction.opcode) {
		case "CREATE_NUMBER":
		case "CREATE_F64":
			return Number.isSafeInteger(instruction.value) && !Object.is(instruction.value, -0);
		case "CREATE_BOOLEAN":
		case "MOVE":
		case "JUMP":
		case "JUMP_IF":
			return true;
		case "BINARY":
			return (
				NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator) ||
				PROPERTY_REGION_COMPARE_OPERATORS.has(instruction.operator)
			);
		case "UNARY":
			return NUMBER_RECORD_UNARY_OPERATORS.has(instruction.operator);
		default:
			return false;
	}
}

function bytecodePredecessors(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	ip: number,
): Array<number> {
	const previous = fn.instructions[ip - 1];
	return [
		...(body.branchSources.get(ip) ?? []),
		...(previous !== undefined &&
		previous.opcode !== "JUMP" &&
		previous.opcode !== "RETURN" &&
		previous.opcode !== "THROW"
			? [ip - 1]
			: []),
	];
}

export interface NativeIntegerLoopShape {
	readonly members: ReadonlySet<number>;
	/** Members in an order that visits each after its predecessors within one iteration. */
	readonly order: ReadonlyArray<number>;
	readonly entryIp: number;
}

/**
 * The innermost loop headed at `header` when control enters it only through one
 * jump to the header and its body is acyclic apart from the edges back to the header.
 */
export function integerLoopShape(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	header: number,
): NativeIntegerLoopShape | undefined {
	if (body.externalEntries.has(header)) return undefined;
	const predecessors = bytecodePredecessors(fn, body, header);
	if (!predecessors.some((source) => source >= header)) return undefined;
	// A back edge leaves an instruction that every path from an entry reaches through the header.
	const outside = new Uint8Array(fn.instructions.length);
	const pending = [0, ...body.externalEntries];
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (ip === header || ip >= fn.instructions.length || outside[ip] === 1) continue;
		outside[ip] = 1;
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "RETURN" || instruction.opcode === "THROW") continue;
		pending.push(...numberRecordSuccessors(instruction, ip));
	}
	const members = new Set([header]);
	const backward = predecessors.filter((source) => outside[source] === 0);
	if (backward.length === 0) return undefined;
	while (backward.length > 0) {
		const ip = backward.pop()!;
		if (members.has(ip)) continue;
		if (members.size >= INTEGER_LOOP_INSTRUCTION_LIMIT) return undefined;
		members.add(ip);
		backward.push(...bytecodePredecessors(fn, body, ip));
	}
	let entryIp: number | undefined;
	for (const source of predecessors) {
		if (members.has(source)) continue;
		const jump = fn.instructions[source]!;
		if (entryIp !== undefined || jump.opcode !== "JUMP") return undefined;
		entryIp = source;
	}
	if (entryIp === undefined) return undefined;
	for (const ip of members) {
		if (ip === header) continue;
		if (
			body.externalEntries.has(ip) ||
			bytecodePredecessors(fn, body, ip).some((source) => !members.has(source))
		)
			return undefined;
	}
	const order = integerLoopOrder(fn, header, members);
	return order === undefined ? undefined : { members, order, entryIp };
}

/** One iteration's members in topological order, when only edges to the header close a cycle. */
export function integerLoopOrder(
	fn: BytecodeFunction,
	header: number,
	members: ReadonlySet<number>,
): ReadonlyArray<number> | undefined {
	const state = new Map<number, "open" | "done">();
	const postorder: Array<number> = [];
	const visit = (ip: number): boolean => {
		const seen = state.get(ip);
		if (seen !== undefined) return seen === "done";
		state.set(ip, "open");
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			if (successor !== header && members.has(successor) && !visit(successor))
				return false;
		state.set(ip, "done");
		postorder.push(ip);
		return true;
	};
	return visit(header) && postorder.length === members.size
		? postorder.reverse()
		: undefined;
}

function lowerIntegerLoopRegion(
	fn: BytecodeFunction,
	header: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	body: NativeBodyFacts,
	conflicts: (ip: number) => boolean,
): NativeIntegerLoopRegionPlan | undefined {
	const shape = integerLoopShape(fn, body, header);
	if (
		shape === undefined ||
		conflicts(shape.entryIp) ||
		shape.order.some(
			(ip) => conflicts(ip) || !integerLoopInstruction(fn.instructions[ip]!),
		) ||
		!shape.order.some((ip) => {
			const instruction = fn.instructions[ip]!;
			return (
				instruction.opcode === "BINARY" &&
				INTEGER_LOOP_PROFITABLE_OPERATORS.has(instruction.operator)
			);
		})
	)
		return undefined;
	const flow = numberRecordDataflow(fn, shape.order, -1, representations);
	if (flow === undefined) return undefined;
	const inputs = new Set(flow.inputs);
	const targets = new Set<number>();
	for (const ip of shape.order)
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			if (!shape.members.has(successor)) targets.add(successor);
	if (targets.size === 0) return undefined;
	const exits: Array<NativeIntegerLoopRegionPlan["exits"][number]> = [];
	for (const targetIp of [...targets].sort((a, b) => a - b)) {
		if (targetIp >= fn.instructions.length) return undefined;
		const outputs = registersLiveAt(fn, body, targetIp, flow.written);
		const assigned = flow.assigned.get(targetIp) ?? new Set<number>();
		for (const register of outputs) {
			const representation = representations[register];
			const kind = flow.kinds.get(register);
			if (
				kind === "number"
					? representation !== "number" &&
						representation !== "int32" &&
						representation !== "boxed"
					: representation !== "boolean" && representation !== "boxed"
			)
				return undefined;
			// A path that skips the write leaves the output with the value it entered with.
			if (!assigned.has(register)) {
				if (numberRecordInputKind(representation) !== kind) return undefined;
				inputs.add(register);
			}
		}
		exits.push(Object.freeze({ targetIp, outputs: Object.freeze(outputs) }));
	}
	const claimedIps = [...shape.members, shape.entryIp].sort((a, b) => a - b);
	return Object.freeze({
		id: header,
		entryIp: shape.entryIp,
		inputs: Object.freeze([...inputs].sort((a, b) => a - b)),
		carried: Object.freeze(
			[...inputs].filter((register) => flow.written.has(register)).sort((a, b) => a - b),
		),
		exits: Object.freeze(exits),
		claimedIps: Object.freeze(claimedIps),
		borrowedRegisters: borrowedRegisters(fn, claimedIps, body),
		fallback: "original-instructions",
	});
}

function lowerConstructorInitialization(
	fn: BytecodeFunction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): NativeConstructorInitializationPlan | undefined {
	if (!fn.isClassConstructor || fn.isDerivedConstructor) return undefined;
	const thisAliases = new Set<number>();
	const stores: Array<{ ip: number; instruction: StaticPropertyStore }> = [];
	const pureIps = new Set<number>();
	let thisEscaped = false;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "LOAD_THIS") {
			thisAliases.add(instruction.dst);
			pureIps.add(ip);
			continue;
		}
		if (instruction.opcode === "MOVE") {
			const aliasesThis = thisAliases.has(instruction.src);
			thisAliases.delete(instruction.dst);
			if (aliasesThis) thisAliases.add(instruction.dst);
			if (propertyReadRegionPureInstruction(instruction, representations))
				pureIps.add(ip);
			continue;
		}
		const usesThis = [...thisAliases].some((register) =>
			vmInstructionUsesRegister(instruction, register),
		);
		if (
			propertyReadRegionPureInstruction(instruction, representations) ||
			(instruction.opcode === "THROW_IF_TDZ" &&
				(thisAliases.has(instruction.src) ||
					["number", "int32", "boolean"].includes(representations[instruction.src]!)))
		)
			pureIps.add(ip);
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
	const storeIps = stores.map(({ ip }) => ip);
	const claimedIps = Array.from({ length: lastIp - firstIp + 1 }, (_, i) => firstIp + i);
	if (
		stores.some(({ ip }) => ip > firstIp && jumpTargets.has(ip)) ||
		[...jumpTargets].some((ip) => ip > firstIp && ip <= lastIp) ||
		// Admission publishes the final shape before the first store; no intervening effect may observe it.
		claimedIps.some((ip) => !storeIps.includes(ip) && (conflicts(ip) || !pureIps.has(ip)))
	) {
		return undefined;
	}
	return Object.freeze({
		id: firstIp,
		stores: Object.freeze(storeIps),
		claimedIps,
		borrowedRegisters: borrowedRegisters(fn, claimedIps),
	});
}

function lowerPrivateFieldReserve(
	fn: BytecodeFunction,
): NativePrivateFieldReservePlan | undefined {
	if (!fn.isClassConstructor || fn.isDerivedConstructor) return undefined;
	const thisAliases = new Set<number>();
	let firstIp: number | undefined;
	let count = 0;
	const claimedIps: Array<number> = [];
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
		const privateCount =
			instruction.opcode === "DEFINE_PRIVATE" && thisAliases.has(instruction.object)
				? 1
				: instruction.opcode === "INIT_PRIVATE_FIELDS" &&
					  thisAliases.has(instruction.object)
					? instruction.keyRegisters.length
					: 0;
		if (privateCount > 0) {
			firstIp ??= ip;
			count += privateCount;
			claimedIps.push(ip);
		}
		for (const register of vmInstructionWriteRegisters(instruction)) {
			thisAliases.delete(register);
		}
	}
	return firstIp === undefined || count < 2
		? undefined
		: Object.freeze({
				id: firstIp,
				count,
				claimedIps,
				borrowedRegisters: borrowedRegisters(fn, claimedIps),
			});
}

function borrowedRegisters(
	fn: BytecodeFunction,
	ips: ReadonlyArray<number>,
	body?: NativeBodyFacts,
): ReadonlyArray<number> {
	const registers = new Set<number>();
	for (const ip of ips) {
		for (const register of body?.reads[ip] ??
			vmInstructionReadRegisters(fn.instructions[ip]!))
			registers.add(register);
		for (const register of body?.writes[ip] ??
			vmInstructionWriteRegisters(fn.instructions[ip]!))
			registers.add(register);
	}
	return [...registers].sort((a, b) => a - b);
}

function lowerPairedArrayLoops(
	fn: BytecodeFunction,
	indexedLoops: ReadonlyArray<NativeIndexedLoopElement>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): ReadonlyArray<NativePairedArrayLoopPlan> {
	const plans: Array<NativePairedArrayLoopPlan> = [];
	for (const indexed of indexedLoops) {
		if (plans.some((plan) => plan.lengthLoadIp === indexed.lengthLoadIp)) continue;
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
		const claimedIps = [
			indexed.lengthLoadIp,
			indexed.elementLoadIp,
			secondary.ip,
			secondary.ip + 1,
		];
		plans.push(
			Object.freeze({
				id: indexed.lengthLoadIp,
				lengthLoadIp: indexed.lengthLoadIp,
				primaryLoadIp: indexed.elementLoadIp,
				primaryObject: indexed.object,
				secondaryLoadIp: secondary.ip,
				secondaryObject: secondary.instruction.object,
				key: indexed.key,
				claimedIps,
				// The admitted receiver pointer survives loop backedges under the parent indexed-loop certificate.
				borrowedRegisters: borrowedRegisters(fn, claimedIps),
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
	selection:
		| { readonly kind: "select" }
		| {
				readonly kind: "render";
				readonly plans: NativeFastPathPlans;
		  },
	indexedLoops: ReadonlyArray<NativeIndexedLoopElement> = [],
	terminalFusion: (
		ip: number,
	) => { readonly id: number; readonly role: "start" | "finish" } | undefined = () =>
		undefined,
	transparentJumpTargets: ReadonlySet<number> = new Set(),
	materializeUpdateOutputs = true,
	selectUpdates = true,
	body?: NativeBodyFacts,
): NativeFastPathLowering {
	let propertyLoadIps: ReadonlyArray<number> = [];
	if (selection.kind === "select") {
		if (body !== undefined) propertyLoadIps = body.staticPropertyLoadIps;
		else {
			const candidates: Array<number> = [];
			for (const [ip, op] of fn.instructions.entries())
				if (op.opcode === "LOAD_PROPERTY_STATIC") candidates.push(ip);
			propertyLoadIps = candidates;
		}
	}
	const handlerTargets =
		selection.kind === "render"
			? []
			: (body?.handlerTargets ??
				(fn.handlers.length === 0
					? []
					: vmExceptionHandlerTargets(fn.instructions.length, fn.handlers)));
	const pairedArrayLoops =
		selection.kind === "render"
			? selection.plans.pairedArrayLoops
			: lowerPairedArrayLoops(fn, indexedLoops, jumpTargets, conflicts);
	const pairedArrayLoopActions = new Map<number, NativePairedArrayLoopAction>();
	for (const plan of pairedArrayLoops) {
		pairedArrayLoopActions.set(plan.lengthLoadIp, { role: "admit", plan });
		pairedArrayLoopActions.set(plan.secondaryLoadIp, { role: "load", plan });
	}
	const propertyNumericUpdates: Array<NativePropertyNumericUpdatePlan> = [];
	const propertyNumericUpdateActions = new Map<
		number,
		NativePropertyNumericUpdateAction
	>();
	const updateAction = (
		plan: NativePropertyNumericUpdatePlan,
		role: NativePropertyNumericUpdateAction["role"],
	): NativePropertyNumericUpdateAction => {
		const load = fn.instructions[plan.loadIp]!,
			store = fn.instructions[plan.storeIp]!;
		if (
			load.opcode !== "LOAD_PROPERTY_STATIC" ||
			store.opcode !== "STORE_PROPERTY_STATIC"
		)
			throw new Error("Invalid native property update references");
		return { plan, role, load, store };
	};
	if (selection.kind === "render")
		propertyNumericUpdates.push(...selection.plans.propertyNumericUpdates);
	else {
		let nextUpdateIp = 0;
		for (const ip of propertyLoadIps) {
			if (!selectUpdates) break;
			if (ip < nextUpdateIp) continue;
			const plan = lowerPropertyNumericUpdate(
				fn,
				ip,
				representations,
				jumpTargets,
				(candidate) =>
					conflicts(candidate) ||
					pairedArrayLoopActions.has(candidate) ||
					propertyNumericUpdateActions.has(candidate),
				transparentJumpTargets,
				materializeUpdateOutputs,
				body,
			);
			if (plan === undefined) continue;
			propertyNumericUpdates.push(plan);
			for (const claimedIp of plan.claimedIps)
				propertyNumericUpdateActions.set(claimedIp, updateAction(plan, "skip"));
			nextUpdateIp = plan.storeIp + 1;
		}
	}
	propertyNumericUpdateActions.clear();
	for (const plan of propertyNumericUpdates) {
		for (const ip of plan.claimedIps)
			propertyNumericUpdateActions.set(ip, updateAction(plan, "skip"));
		propertyNumericUpdateActions.set(plan.loadIp, updateAction(plan, "load"));
		if (plan.constantIp !== undefined)
			propertyNumericUpdateActions.set(plan.constantIp, updateAction(plan, "constant"));
	}

	const propertyProjections: Array<NativePropertyProjectionPlan> = [];
	const propertyProjectionActions = new Map<number, NativePropertyProjectionAction>();
	for (const ip of propertyLoadIps) {
		if (ip + 1 >= fn.instructions.length) break;
		if (propertyProjectionActions.has(ip)) continue;
		const plan = lowerPropertyProjection(
			fn,
			ip,
			representations,
			jumpTargets,
			(candidate) =>
				conflicts(candidate) ||
				pairedArrayLoopActions.has(candidate) ||
				propertyNumericUpdateActions.has(candidate) ||
				propertyProjectionActions.has(candidate),
			terminalFusion,
			transparentJumpTargets,
			handlerTargets,
			body,
		);
		if (plan === undefined) continue;
		propertyProjections.push(plan);
		for (const claimedIp of plan.claimedIps)
			propertyProjectionActions.set(claimedIp, { role: "skip", plan });
	}
	if (selection.kind === "render")
		propertyProjections.push(...selection.plans.propertyProjections);
	propertyProjectionActions.clear();
	for (const plan of propertyProjections) {
		for (const [index, load] of plan.loads.entries()) {
			propertyProjectionActions.set(load.ip, { role: "load", plan, index });
		}
		for (const [index, step] of plan.steps.entries()) {
			propertyProjectionActions.set(step.ip, { role: "step", plan, index });
		}
		for (const skippedIp of plan.skippedIps) {
			propertyProjectionActions.set(skippedIp, { role: "skip", plan });
		}
		if (plan.terminalStore !== undefined) {
			propertyProjectionActions.set(plan.terminalStore.ip, { role: "store", plan });
		}
	}
	const propertyReadRegions: Array<NativePropertyReadRegionPlan> = [];
	const propertyReadRegionActions = new Map<number, NativePropertyReadRegionAction>();
	if (selection.kind === "render")
		propertyReadRegions.push(...selection.plans.propertyReadRegions);
	else {
		let nextRegionIp = 0;
		for (const ip of propertyLoadIps) {
			if (ip < nextRegionIp) continue;
			const plan = lowerPropertyReadRegion(
				fn,
				ip,
				representations,
				jumpTargets,
				(candidate) =>
					conflicts(candidate) ||
					terminalFusion(candidate) !== undefined ||
					pairedArrayLoopActions.has(candidate) ||
					propertyNumericUpdateActions.has(candidate) ||
					propertyProjectionActions.has(candidate),
				body,
			);
			if (plan === undefined) continue;
			propertyReadRegions.push(plan);
			nextRegionIp = plan.endIp + 1;
		}
	}
	for (const plan of propertyReadRegions)
		for (const [index, load] of plan.loads.entries())
			propertyReadRegionActions.set(load.ip, { plan, index });
	const readRegionClaims = new Set(
		selection.kind === "select"
			? propertyReadRegions.flatMap((plan) => plan.claimedIps)
			: [],
	);
	const propertyReadPairs: Array<NativePropertyReadPairPlan> = [];
	const propertyReadPairActions = new Map<number, NativePropertyReadPairAction>();
	if (selection.kind === "render")
		propertyReadPairs.push(...selection.plans.propertyReadPairs);
	else {
		let nextPairIp = 0;
		for (const ip of propertyLoadIps) {
			if (ip < nextPairIp) continue;
			if (ip + 1 >= fn.instructions.length) break;
			const first = fn.instructions[ip]!,
				second = fn.instructions[ip + 1]!;
			if (
				first.opcode !== "LOAD_PROPERTY_STATIC" ||
				second.opcode !== "LOAD_PROPERTY_STATIC" ||
				first.object !== second.object ||
				first.dst === first.object ||
				representations[first.dst] !== "boxed" ||
				representations[second.dst] !== "boxed" ||
				jumpTargets.has(ip + 1) ||
				[ip, ip + 1].some(
					(candidate) =>
						conflicts(candidate) ||
						pairedArrayLoopActions.has(candidate) ||
						propertyNumericUpdateActions.has(candidate) ||
						propertyProjectionActions.has(candidate) ||
						readRegionClaims.has(candidate),
				)
			)
				continue;
			propertyReadPairs.push(
				Object.freeze({
					id: ip,
					object: first.object,
					loads: [
						{ ip, icIndex: first.icIndex },
						{ ip: ip + 1, icIndex: second.icIndex },
					],
					claimedIps: [ip, ip + 1],
					borrowedRegisters: [...new Set([first.object, first.dst, second.dst])].sort(
						(a, b) => a - b,
					),
					fallback: "original-instructions",
				}),
			);
			nextPairIp = ip + 2;
		}
	}
	for (const plan of propertyReadPairs) {
		propertyReadPairActions.set(plan.loads[0]!.ip, { plan, role: "first" });
		propertyReadPairActions.set(plan.loads[1]!.ip, { plan, role: "second" });
	}

	const constructorInitialization =
		selection.kind === "render"
			? selection.plans.constructorInitialization
			: lowerConstructorInitialization(
					fn,
					representations,
					jumpTargets,
					(candidate) =>
						conflicts(candidate) ||
						pairedArrayLoopActions.has(candidate) ||
						propertyNumericUpdateActions.has(candidate) ||
						propertyProjectionActions.has(candidate),
				);
	const privateFieldReserve =
		selection.kind === "render"
			? selection.plans.privateFieldReserve
			: lowerPrivateFieldReserve(fn);
	const constructorInitializationActions = new Map<
		number,
		NativeConstructorInitializationAction
	>();
	const constructorStores =
		constructorInitialization?.stores.map((ip) => {
			const instruction = fn.instructions[ip]!;
			if (instruction.opcode !== "STORE_PROPERTY_STATIC")
				throw new Error("Invalid native constructor store reference");
			return instruction;
		}) ?? [];
	for (const [index, store] of constructorInitialization?.stores.entries() ?? []) {
		constructorInitializationActions.set(store, {
			plan: constructorInitialization!,
			index,
			stores: constructorStores,
		});
	}
	return Object.freeze({
		literalPropertyDefinitions:
			selection.kind === "render" ? selection.plans.literalPropertyDefinitions : [],
		mathCalls: selection.kind === "render" ? selection.plans.mathCalls : [],
		numberPredicates: selection.kind === "render" ? selection.plans.numberPredicates : [],
		stringTransforms: selection.kind === "render" ? selection.plans.stringTransforms : [],
		arrayPresence: selection.kind === "render" ? selection.plans.arrayPresence : [],
		arrayPairDestructure:
			selection.kind === "render" ? selection.plans.arrayPairDestructure : [],
		pairedArrayLoops,
		pairedArrayLoopActions,
		propertyNumericUpdates: Object.freeze(propertyNumericUpdates),
		propertyNumericUpdateActions,
		propertyProjections: Object.freeze(propertyProjections),
		propertyProjectionActions,
		propertyReadRegions: Object.freeze(propertyReadRegions),
		propertyReadRegionActions,
		propertyReadPairs: Object.freeze(propertyReadPairs),
		propertyReadPairActions,
		numberRecordRegions:
			selection.kind === "render" ? selection.plans.numberRecordRegions : [],
		integerLoopRegions:
			selection.kind === "render" ? selection.plans.integerLoopRegions : [],
		...(constructorInitialization === undefined ? {} : { constructorInitialization }),
		constructorInitializationActions,
		...(privateFieldReserve === undefined ? {} : { privateFieldReserve }),
	});
}

function selectArrayWindows(
	native: NativeFunctionPlan,
	reserved: ReadonlySet<number>,
	pairedArrayLoops: ReadonlyArray<NativePairedArrayLoopPlan>,
	body: NativeBodyFacts,
): Pick<NativeFastPathPlans, "arrayPresence" | "arrayPairDestructure"> {
	const fn = native.body;
	const entries = body.externalEntries;
	const polls = new Set(
		native.gc.safepoints
			.filter((point) => point.kind === "loop-backedge")
			.map((point) => point.instructionIp),
	);
	const incoming = body.branchSources;
	const owners = new Map<number, Array<number>>();
	for (const [index, region] of native.specializations.entries())
		for (const ip of region.claimedIps) {
			const regions = owners.get(ip) ?? [];
			regions.push(index);
			owners.set(ip, regions);
		}
	const claimed = new Set(reserved);
	const window = (
		regionIndex: number,
		start: number,
		end: number,
		sharedPrimaryLoad?: number,
	) => {
		const ips = Array.from({ length: end - start + 1 }, (_, index) => start + index);
		if (
			pairedArrayLoops.some((plan) =>
				plan.claimedIps.some(
					(ip) => ip >= start && ip <= end && ip !== sharedPrimaryLoad,
				),
			) ||
			ips.some(
				(ip) => claimed.has(ip) || polls.has(ip) || (ip > start && entries.has(ip)),
			) ||
			ips.some((ip) =>
				(owners.get(ip) ?? []).some((index) => {
					if (index === regionIndex) return false;
					const parent = native.specializations[regionIndex]!,
						region = native.specializations[index]!;
					// Result virtualization is the cursor's noncollecting step overlay.
					return !(
						parent.kind === "array-values-iterator-cursor" &&
						region.kind === "iterator-result-virtualization" &&
						region.stepIps.every((step) => parent.stepIps.includes(step))
					);
				}),
			) ||
			ips.some(
				(ip) =>
					ip > start &&
					(incoming.get(ip) ?? []).some((source) => source < start || source > end),
			)
		)
			return undefined;
		return ips;
	};
	const borrow = (ips: ReadonlyArray<number>) =>
		[...new Set(ips.flatMap((ip) => [...body.reads[ip]!, ...body.writes[ip]!]))].sort(
			(left, right) => left - right,
		);
	const arrayPresence: Array<NativeArrayPresencePlan> = [];
	const arrayPairDestructure: Array<NativeArrayPairDestructurePlan> = [];
	for (const [regionIndex, region] of native.specializations.entries()) {
		if (region.kind === "indexed-length-loop") {
			for (const [siteIndex, site] of region.sites.entries())
				for (const [elementIndex, element] of site.elements.entries()) {
					if (element.kind !== "load" || element.arrayIndexIsUint32 !== true) continue;
					const loadIp = element.ip,
						membershipIp = loadIp - 3;
					const membership = fn.instructions[membershipIp],
						branch = fn.instructions[membershipIp + 1],
						skip = fn.instructions[membershipIp + 2],
						load = fn.instructions[loadIp];
					if (
						membership?.opcode !== "BINARY" ||
						membership.operator !== "in" ||
						branch?.opcode !== "JUMP_IF" ||
						branch.cond !== membership.dst ||
						branch.targetIp !== loadIp ||
						skip?.opcode !== "JUMP" ||
						skip.targetIp <= loadIp ||
						load?.opcode !== "LOAD_PROPERTY" ||
						membership.left !== load.key ||
						membership.right !== load.object ||
						!["boolean", "boxed"].includes(
							native.registerRepresentations[membership.dst]!,
						)
					)
						continue;
					const paired = pairedArrayLoops.find(
						(plan) => plan.lengthLoadIp === site.loadIp && plan.primaryLoadIp === loadIp,
					);
					const claimedIps = window(
						regionIndex,
						membershipIp,
						loadIp,
						paired?.primaryLoadIp,
					);
					if (claimedIps === undefined) continue;
					arrayPresence.push({
						regionIndex,
						siteIndex,
						elementIndex,
						membershipIp,
						loadIp,
						claimedIps,
						borrowedRegisters: borrow(claimedIps),
						fallback: "original-instructions",
					});
					for (const ip of claimedIps) claimed.add(ip);
				}
		} else if (
			region.kind === "array-values-iterator-cursor" &&
			region.stepIps.length === 2
		) {
			const initializeIp = region.initializeIp,
				[firstStepIp, secondStepIp] = region.stepIps as [number, number];
			const first = fn.instructions[firstStepIp],
				second = fn.instructions[secondStepIp],
				branch = fn.instructions[secondStepIp + 1],
				closeJump = fn.instructions[secondStepIp + 2],
				closeIp = secondStepIp + 3,
				close = fn.instructions[closeIp],
				afterClose = fn.instructions[secondStepIp + 4],
				continuationIp = secondStepIp + 5;
			if (
				fn.isAsync ||
				fn.isGenerator ||
				firstStepIp !== initializeIp + 1 ||
				secondStepIp !== firstStepIp + 1 ||
				first?.opcode !== "ITERATOR_STEP" ||
				second?.opcode !== "ITERATOR_STEP" ||
				branch?.opcode !== "JUMP_IF" ||
				branch.cond !== second.doneDst ||
				branch.targetIp !== continuationIp ||
				closeJump?.opcode !== "JUMP" ||
				closeJump.targetIp !== closeIp ||
				close?.opcode !== "ITERATOR_CLOSE" ||
				!close.normal ||
				close.iterator !== region.iterator ||
				afterClose?.opcode !== "JUMP" ||
				afterClose.targetIp !== continuationIp ||
				[first, second].some(
					(step) =>
						native.registerRepresentations[step.valueDst] !== "boxed" ||
						!["boolean", "boxed"].includes(native.registerRepresentations[step.doneDst]!),
				)
			)
				continue;
			const claimedIps = window(regionIndex, initializeIp, continuationIp - 1);
			if (claimedIps === undefined) continue;
			arrayPairDestructure.push({
				regionIndex,
				initializeIp,
				firstStepIp,
				secondStepIp,
				closeIp,
				continuationIp,
				claimedIps,
				borrowedRegisters: borrow(claimedIps),
				fallback: "original-iterator-protocol",
			});
			for (const ip of claimedIps) claimed.add(ip);
		}
	}
	return { arrayPresence, arrayPairDestructure };
}

function stringConstantIsArrayIndex(units: ReadonlyArray<number>): boolean {
	if (units.length === 0) return false;
	if (units[0] === 0x30) return units.length === 1;
	if (units[0]! < 0x31 || units[0]! > 0x39) return false;
	let index = 0;
	for (const unit of units) {
		if (unit < 0x30 || unit > 0x39) return false;
		index = index * 10 + unit - 0x30;
		if (index > 0xffff_fffe) return false;
	}
	return true;
}

export function selectNativeFastPaths(
	native: NativeFunctionPlan,
	entry?: NativeDirectEntryPlan,
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	body = analyzeNativeBodyFacts(native.body),
): NativeFastPathPlans {
	const fn = native.body;
	const { handlerEntries, jumpTargets, branchSources } = body;
	const literalPropertyDefinitions: Array<NativeLiteralPropertyDefinitionPlan> = [];
	const mathCalls: Array<NativeMathCallPlan> = [];
	const numberPredicates: Array<NativeNumberPredicatePlan> = [];
	const stringTransforms: Array<NativeStringTransformPlan> = [];
	const numericOperand = (operand: number): boolean => {
		const decoded = decodeVmValueOperand(operand);
		return (
			decoded.kind === "number" ||
			(decoded.kind === "register" &&
				isNumericRepresentation(native.registerRepresentations[decoded.register]!))
		);
	};
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "CALL_KNOWN") {
			const transform = selectNativeStringTransform(native, ip, stringConstants);
			if (transform !== undefined) stringTransforms.push(transform);
		}
		if (
			op.opcode === "CALL_KNOWN" &&
			!op.construct &&
			op.argumentMode === undefined &&
			NUMBER_PREDICATES.has(op.operation)
		) {
			const first = op.arguments[0];
			const input = first === undefined ? undefined : decodeVmValueOperand(first);
			const rep =
				input?.kind === "register"
					? native.registerRepresentations[input.register]
					: undefined;
			const proof = native.instructions[ip];
			const exactNumber =
				proof?.kind === "exact-builtin-input-kinds" &&
				compilerBuiltinInputKindsAreValid(
					proof.inputKindMasks,
					op.arguments.length + 1,
				) &&
				proof.inputKindMasks[1] === COMPILER_VALUE_KIND_NUMBER;
			const mode =
				input === undefined ||
				(input.kind !== "register" && input.kind !== "number") ||
				rep === "string" ||
				rep === "boolean"
					? "non-number"
					: rep === "int32"
						? "int32"
						: input.kind === "number" || rep === "number" || exactNumber
							? "number"
							: "boxed";
			numberPredicates.push({ instructionIp: ip, mode });
		}
		const prior = fn.instructions[ip - 1];
		if (
			op.opcode === "DEFINE_PROPERTY" &&
			prior?.opcode === "CREATE_STRING" &&
			prior.dst === op.key &&
			!jumpTargets.has(ip)
		) {
			const units = stringConstants[prior.stringIndex];
			if (units !== undefined && !stringConstantIsArrayIndex(units)) {
				literalPropertyDefinitions.push({
					instructionIp: ip,
					stringIndex: prior.stringIndex,
				});
			}
		}
		const plan = native.instructions[ip];
		const builtin = plan?.kind === "call" ? plan.guardedBuiltinCall : undefined;
		if (op.opcode !== "CALL" || builtin === undefined) continue;
		const arity =
			op.arguments.length === 1 && MATH_UNARY_NATIVE_CALL.has(builtin.operation)
				? 1
				: op.arguments.length === 2 && MATH_BINARY_OPERATIONS.has(builtin.operation)
					? 2
					: undefined;
		if (arity === undefined) continue;
		const numeric =
			op.arguments.every(numericOperand) &&
			(native.registerRepresentations[op.dst] === "number" ||
				(builtin.guard.dependencies.length > 0 &&
					builtin.guard.dependencies.every(
						(dependency) =>
							dependency.kind === "world" && dependency.fact === "primordials.locked",
					)));
		mathCalls.push({
			instructionIp: ip,
			operation: builtin.operation,
			arity,
			mode: numeric ? "number" : "guarded-boxed",
		});
	}
	const transparent = new Set<number>();
	if (native.mode === "direct" && (native.literalSwitches?.length ?? 0) === 0) {
		for (const [ip, op] of fn.instructions.entries()) {
			if (
				op.opcode === "JUMP" &&
				op.targetIp === ip + 1 &&
				branchSources.get(ip + 1)?.length === 1 &&
				!handlerEntries.has(ip + 1)
			)
				transparent.add(ip + 1);
		}
	}
	const blocked = new Set(
		entry?.fieldParameters?.loads.map((load) => load.instructionIp),
	);
	// A physically forward copy edge can still poll on a native or exceptional cycle.
	const pollingEdges = new Set(
		native.gc.safepoints.flatMap((point) =>
			point.kind === "loop-backedge" ? [point.instructionIp] : [],
		),
	);
	const unavailable = (ip: number) => blocked.has(ip) || pollingEdges.has(ip);
	for (const site of native.fieldCalls ?? [])
		for (let ip = site.allocationIp; ip <= site.callIp; ip++) blocked.add(ip);
	for (const site of native.literalSwitches ?? [])
		for (let ip = site.instructionIp; ip <= site.endIp; ip++) blocked.add(ip);
	const fusions = new Map<
		number,
		{ readonly id: number; readonly role: "start" | "finish" }
	>();
	const indexedLoops: Array<NativeIndexedLoopElement> = [];
	for (const action of native.regionActions) {
		const region = native.specializations[action.regionIndex]!;
		if (region.kind !== "numeric-fusion") {
			blocked.add(action.ip);
			for (const ip of region.claimedIps) blocked.add(ip);
		}
		switch (region.kind) {
			case "numeric-fusion": {
				const pair = region.pairs[action.primaryIndex!]!;
				if (
					native.instructions[pair.firstIp]?.kind !== "unsigned-arithmetic" &&
					native.instructions[pair.finishIp]?.kind !== "unsigned-arithmetic"
				) {
					if (action.role !== "start" && action.role !== "finish")
						throw new Error("Invalid numeric-fusion action");
					fusions.set(action.ip, { id: pair.firstIp, role: action.role });
				}
				break;
			}
			case "indexed-length-loop": {
				blocked.add(action.ip);
				const site = region.sites[action.primaryIndex!]!;
				const element =
					action.role === "element" ? site.elements[action.secondaryIndex!] : undefined;
				const op = fn.instructions[action.ip]!;
				if (
					element?.kind === "load" &&
					element.arrayIndexIsUint32 &&
					op.opcode === "LOAD_PROPERTY"
				)
					indexedLoops.push({
						lengthLoadIp: site.loadIp,
						elementLoadIp: action.ip,
						object: op.object,
						key: op.key,
						result: op.dst,
					});
				break;
			}
		}
	}
	const numberRecordRegions: Array<NativeNumberRecordRegionPlan> = [];
	const integerLoopRegions: Array<NativeIntegerLoopRegionPlan> = [];
	// Profiled sites observe each original instruction.
	if (
		native.mode === "direct" &&
		!fn.isGenerator &&
		!fn.isAsync &&
		fn.profileSiteIds === undefined
	) {
		for (const ip of body.staticPropertyLoadIps) {
			if (unavailable(ip)) continue;
			const plan = lowerNumberRecordRegion(
				fn,
				ip,
				native.registerRepresentations,
				body,
				(candidate) =>
					unavailable(candidate) ||
					native.instructions[candidate] !== undefined ||
					fusions.has(candidate),
			);
			if (plan === undefined) continue;
			numberRecordRegions.push(plan);
			for (const claimedIp of plan.claimedIps) blocked.add(claimedIp);
		}
		for (const header of [...body.jumpTargets].sort((a, b) => a - b)) {
			if (blocked.has(header)) continue;
			const plan = lowerIntegerLoopRegion(
				fn,
				header,
				native.registerRepresentations,
				body,
				// Its back edge polls by returning the iteration to the original loop.
				(candidate) => {
					const kind = native.instructions[candidate]?.kind;
					return (
						blocked.has(candidate) ||
						fusions.has(candidate) ||
						// Operand kind proofs refine the double lowering; the region replaces it.
						(kind !== undefined &&
							kind !== "exact-operator-input-kinds" &&
							kind !== "unsigned-arithmetic")
					);
				},
			);
			if (plan === undefined) continue;
			integerLoopRegions.push(plan);
			for (const claimedIp of plan.claimedIps) blocked.add(claimedIp);
		}
	}
	const selected = lowerNativeFastPaths(
		fn,
		native.registerRepresentations,
		jumpTargets,
		(ip) => unavailable(ip) || native.instructions[ip] !== undefined,
		{ kind: "select" },
		indexedLoops,
		(ip) => fusions.get(ip),
		transparent,
		// Every other consumer reads its registers through bytecode operands.
		fn.profileSiteIds !== undefined,
		// Fusion can keep a preceding RHS in its private temporary rather than the semantic local.
		!native.specializations.some((region) => region.kind === "numeric-fusion"),
		body,
	);
	return {
		literalPropertyDefinitions,
		mathCalls,
		numberPredicates,
		stringTransforms,
		...selectArrayWindows(
			native,
			new Set([
				...(entry?.fieldParameters?.loads.map((load) => load.instructionIp) ?? []),
				...(native.fieldCalls ?? []).flatMap((site) =>
					Array.from(
						{ length: site.callIp - site.allocationIp + 1 },
						(_, index) => site.allocationIp + index,
					),
				),
				...(native.literalSwitches ?? []).flatMap((site) =>
					Array.from(
						{ length: site.endIp - site.instructionIp + 1 },
						(_, index) => site.instructionIp + index,
					),
				),
				...[
					...selected.propertyProjections,
					...selected.propertyNumericUpdates,
					...selected.propertyReadRegions,
					...selected.propertyReadPairs,
					...numberRecordRegions,
					...integerLoopRegions,
					...(selected.constructorInitialization === undefined
						? []
						: [selected.constructorInitialization]),
					...(selected.privateFieldReserve === undefined
						? []
						: [selected.privateFieldReserve]),
				].flatMap((plan) => plan.claimedIps),
			]),
			selected.pairedArrayLoops,
			body,
		),
		propertyProjections: selected.propertyProjections,
		propertyNumericUpdates: selected.propertyNumericUpdates,
		propertyReadRegions: selected.propertyReadRegions,
		propertyReadPairs: selected.propertyReadPairs,
		numberRecordRegions,
		integerLoopRegions,
		pairedArrayLoops: selected.pairedArrayLoops,
		...(selected.constructorInitialization === undefined
			? {}
			: { constructorInitialization: selected.constructorInitialization }),
		...(selected.privateFieldReserve === undefined
			? {}
			: { privateFieldReserve: selected.privateFieldReserve }),
	};
}
