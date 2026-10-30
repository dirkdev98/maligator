import { ARRAY_INITIALIZATION_LIMITS } from "../shared/array-initialization.ts";
import { DATA_VIEW_ACCESSOR_TYPES } from "../shared/builtin-registry.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	compilerBuiltinInputKindsAreValid,
} from "../shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../shared/instruction-facts.ts";
import { bytecodeLoopInstructions } from "./bytecode-loops.ts";
import { selectNativeStringTransform } from "./lower-native-string-transforms.ts";
import type { NativeStringTransformPlan } from "./lower-native-string-transforms.ts";
import { selectNativeArrayInitializations } from "./native-array-initialization.ts";
import type { NativeArrayInitialization } from "./native-array-initialization.ts";
import { analyzeNativeBodyFacts } from "./native-body-facts.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import { selectNativeMapEntries } from "./native-map-entry-plan.ts";
import type { NativeMapEntryPlan } from "./native-map-entry-plan.ts";
import { selectNativeObjectEnumerationSnapshots } from "./native-object-enumeration-snapshot.ts";
import type { NativeObjectEnumerationSnapshotPlan } from "./native-object-enumeration-snapshot.ts";
import {
	nativeGuardedMathArity,
	NUMBER_PREDICATES,
	nativeMathNumberArity,
} from "./native-scalar-operators.ts";
import { selectNativeSpanContinuations } from "./native-span-continuation.ts";
import type { NativeSpanContinuation } from "./native-span-continuation.ts";
import { createNativeStringLiteralQuery } from "./native-string-literals.ts";
import { nativePlanKeepsOrdinaryLowering, nativeRecordCallIps } from "./program-image.ts";
import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	NativeInstructionPlan,
	VmRegisterRepresentation,
} from "./program-image.ts";
import {
	decodeVmValueOperand,
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionUsesRegister,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	DecodedVmValueOperand,
} from "./runtime-image.ts";

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

interface NativeNumericLoopRegionBase {
	/** The loop header; control reaches it from outside only through `entryIp`'s jump. */
	readonly id: number;
	readonly entryIp: number;
	/** Registers an iteration can read before writing them. */
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

/** A counted loop's index, which the header compares with a bound and each iteration steps once. */
export interface NativeNumericLoopCounter {
	readonly index: number;
	readonly bound: number;
	/** The view whose length the header loads into `bound` on every iteration. */
	readonly boundObject?: number;
	/** The header comparison, whose operands may each be `index` or `bound` plus a constant. */
	readonly comparison: number;
	/** The loop continues while `index` compares to `bound + limitOffset` as the comparison does. */
	readonly limitOffset: number;
	readonly stride: number;
}

export type NativeNumericLoopRegionPlan = NativeNumericLoopRegionBase &
	(
		| { readonly kind: "integer" }
		| {
				/** A for-of over an Array whose deferred cursor the header steps. */
				readonly kind: "array-iteration";
				readonly initializeIp: number;
				readonly iterator: number;
				readonly records?: ReadonlyArray<number>;
		  }
		| {
				readonly kind: "fixed-numeric";
				/** Absent when every view access is a read that checks its own key. */
				readonly counter?: NativeNumericLoopCounter;
				/** Registers holding an Array view's object element, used only to read its fields. */
				readonly records?: ReadonlyArray<number>;
				readonly views: ReadonlyArray<{
					readonly object: number;
					readonly writable: boolean;
					readonly minOffset: number;
					readonly maxOffset: number;
					/** Read through keys unrelated to the index, each checked against the view's length. */
					readonly checked?: true;
					/** A primitive string read through a world-licensed `charCodeAt`. */
					readonly text?: true;
					/**
					 * A DataView, accessed through its intrinsic accessors at bytes `byteScale`
					 * times the index plus an offset, with `minOffset` and `maxOffset` bounding
					 * every byte an access covers.
					 */
					readonly byteScale?: number;
				}>;
				/** The DataView accessor calls the region performs on its byte views. */
				readonly dataViewCalls?: ReadonlyArray<NativeDataViewCall>;
		  }
	);

export type NativeDataViewAccessorType = (typeof DATA_VIEW_ACCESSOR_TYPES)[number];

/** An accessor call of `DataView.prototype` at `ip`. */
export interface NativeDataViewCall {
	readonly ip: number;
	readonly set: boolean;
	readonly type: NativeDataViewAccessorType;
}

export const DATA_VIEW_ELEMENT_SIZES: Readonly<
	Record<NativeDataViewAccessorType, number>
> = {
	Int8: 1,
	Uint8: 1,
	Int16: 2,
	Uint16: 2,
	Int32: 4,
	Uint32: 4,
	Float32: 4,
	Float64: 8,
};

/** The accessor a `DataView.prototype` method name selects, if compiled code performs it inline. */
export function nativeDataViewAccessor(
	method: string,
): Omit<NativeDataViewCall, "ip"> | undefined {
	const kind = method.slice(0, 3);
	const type = DATA_VIEW_ACCESSOR_TYPES.find(
		(candidate) => method.slice(3) === candidate,
	);
	return (kind === "get" || kind === "set") && type !== undefined
		? { set: kind === "set", type }
		: undefined;
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
}

export const NATIVE_NUMBER_PREDICATE_MODES = [
	"boxed",
	"non-number",
	"integer",
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
	readonly arrayInitializations: ReadonlyArray<NativeArrayInitialization>;
	readonly mapEntries: ReadonlyArray<NativeMapEntryPlan>;
	readonly objectEnumerationSnapshots: ReadonlyArray<NativeObjectEnumerationSnapshotPlan>;
	readonly spanContinuations: ReadonlyArray<NativeSpanContinuation>;
	readonly propertyNumericUpdates: ReadonlyArray<NativePropertyNumericUpdatePlan>;
	readonly propertyProjections: ReadonlyArray<NativePropertyProjectionPlan>;
	readonly propertyReadRegions: ReadonlyArray<NativePropertyReadRegionPlan>;
	readonly propertyReadPairs: ReadonlyArray<NativePropertyReadPairPlan>;
	readonly numberRecordRegions: ReadonlyArray<NativeNumberRecordRegionPlan>;
	readonly numericLoopRegions: ReadonlyArray<NativeNumericLoopRegionPlan>;
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
	) => { readonly id: number; readonly role: "start" | "finish" | "link" } | undefined,
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
	// A fused step leaves its result unmaterialized for the next step, which consumes it.
	// Rendering publishes such a value only from a final start, so every other fused value
	// must pass between neighboring steps of this projection, through a chain's links too.
	for (const [index, step] of steps.entries()) {
		const role = terminalFusion(step.ip)?.role;
		if (role === undefined) continue;
		const previous = index === 0 ? undefined : terminalFusion(steps[index - 1]!.ip)?.role;
		const next =
			index === steps.length - 1 ? undefined : terminalFusion(steps[index + 1]!.ip)?.role;
		if (role !== "start" && previous !== "start" && previous !== "link") return undefined;
		if (
			role !== "finish" &&
			next !== "finish" &&
			next !== "link" &&
			!(role === "start" && next === undefined)
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
		case "CREATE_STRING":
		case "CREATE_NULL":
		case "CREATE_UNDEFINED":
		case "TYPEOF_COMPARE":
		case "IS_EMPTY":
			return true;
		case "MOVE":
			return (
				representations[instruction.src] === representations[instruction.dst] ||
				(isNumericRepresentation(representations[instruction.src]!) &&
					isNumericRepresentation(representations[instruction.dst]!))
			);
		case "BINARY":
			return (
				instruction.operator === "===" ||
				instruction.operator === "!==" ||
				(isNumericRepresentation(representations[instruction.left]!) &&
					isNumericRepresentation(representations[instruction.right]!) &&
					(isNumericRepresentation(representations[instruction.dst]!) ||
						representations[instruction.dst] === "boolean") &&
					(NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator) ||
						PROPERTY_REGION_COMPARE_OPERATORS.has(instruction.operator)))
			);
		case "UNARY":
			return (
				instruction.operator === "!" ||
				(isNumericRepresentation(representations[instruction.src]!) &&
					(isNumericRepresentation(representations[instruction.dst]!) ||
						representations[instruction.dst] === "boolean") &&
					PROPERTY_REGION_UNARY_OPERATORS.has(instruction.operator))
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
	body: NativeBodyFacts,
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
	const admitted = new Map([[firstIp, new Set([first.object])]]);
	const claimed = [firstIp];
	const limit = Math.min(fn.instructions.length, firstIp + 128);
	for (let ip = firstIp + 1; ip < limit; ip++) {
		const sources = body.branchSources.get(ip) ?? [];
		const previous = fn.instructions[ip - 1]!;
		const fallsThrough = !["JUMP", "RETURN", "THROW", "LOAD_UNDECLARED"].includes(
			previous.opcode,
		);
		// Every incoming edge must retain the admission; an unsafe arm poisons its join.
		if (
			body.externalEntries.has(ip) ||
			(jumpTargets.has(ip) && sources.length === 0) ||
			(fallsThrough && !admitted.has(ip - 1)) ||
			sources.some((source) => source >= ip || !admitted.has(source)) ||
			(!fallsThrough && sources.length === 0) ||
			conflicts(ip)
		)
			continue;
		const predecessors = [...(fallsThrough ? [ip - 1] : []), ...sources];
		const aliases = new Set(admitted.get(predecessors[0]!));
		for (const predecessor of predecessors.slice(1))
			for (const alias of aliases)
				if (!admitted.get(predecessor)!.has(alias)) aliases.delete(alias);
		if (aliases.size === 0) continue;
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			aliases.has(instruction.object) &&
			representations[instruction.dst] === "boxed"
		) {
			loads.push({ ip, instruction });
			claimed.push(ip);
			if (loads.length === 32) break;
			aliases.delete(instruction.dst);
			if (aliases.size > 0) admitted.set(ip, aliases);
			continue;
		}
		const forwardBranch =
			(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
			instruction.targetIp > ip;
		if (
			!forwardBranch &&
			!propertyReadRegionPureInstruction(instruction, representations)
		) {
			continue;
		}
		const copiesReceiver = instruction.opcode === "MOVE" && aliases.has(instruction.src);
		for (const register of body.writes[ip]!) aliases.delete(register);
		if (copiesReceiver && instruction.opcode === "MOVE") aliases.add(instruction.dst);
		if (aliases.size === 0) continue;
		admitted.set(ip, aliases);
		claimed.push(ip);
	}
	if (loads.length < 2 || (loads.length === 2 && loads[1]!.ip === firstIp + 1)) {
		// Preserve the smaller existing adjacent-pair admission.
		return undefined;
	}
	const claimedIps = claimed.filter((ip) => ip <= loads.at(-1)!.ip);
	if (
		claimedIps.some((ip) => {
			const opcode = fn.instructions[ip]!.opcode;
			return opcode === "JUMP" || opcode === "JUMP_IF";
		})
	) {
		const members = new Set(claimedIps);
		const readIps = new Set(loads.map(({ ip }) => ip));
		const minimumReads = new Map([[firstIp, 0]]);
		for (const ip of claimedIps) {
			const before = minimumReads.get(ip);
			if (before === undefined) continue;
			const count = before + (readIps.has(ip) ? 1 : 0);
			for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip)) {
				if (!members.has(successor)) {
					// Mutually exclusive loads cannot amortize retained storage on a short arm.
					if (count < 3) return undefined;
				} else {
					minimumReads.set(
						successor,
						Math.min(minimumReads.get(successor) ?? count, count),
					);
				}
			}
		}
	}
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

const NUMBER_RECORD_INSTRUCTION_LIMIT = 128;
const NUMBER_RECORD_FIELD_LIMIT = 32;
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
		case "CALL_KNOWN":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER": {
			const builtin = nativeNumericBuiltinInstruction(instruction);
			return (
				builtin !== undefined &&
				instruction.dst !== object &&
				builtin.arguments.every(
					(argument) => argument.kind === "number" || argument.register !== object,
				)
			);
		}
		case "LOAD_PROPERTY_STATIC":
			return instruction.object === object && instruction.dst !== object;
		case "STORE_PROPERTY_STATIC":
			return instruction.object === object && instruction.value !== object;
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
		case "LOAD_INTRINSIC":
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
	indexed = false,
	// `charCodeAt` calls a string region reads as code units.
	codeUnitReads?: ReadonlySet<number>,
	// Loop regions load the bindings they read at entry; record regions do not.
	bindingLoads = indexed,
	// DataView accessor calls a loop region performs on its byte views.
	dataViewCalls: ReadonlyMap<number, NativeDataViewCall> = new Map(),
): NativeNumberRecordDataflow | undefined {
	const kinds = new Map<number, NativeNumberRecordKind>();
	const inputs = new Set<number>();
	const written = new Set<number>();
	const methods = numericLoopCallMethods(
		fn,
		order,
		codeUnitReads ?? new Set(),
		dataViewCalls,
	);
	const numericReads = new Set<number>();
	const intrinsics = new Set<number>();
	const bindings = new Set<number>();
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
			if (intrinsics.has(register)) return false;
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
			return kind !== undefined && !intrinsics.has(register) && unify(register, kind);
		};
		let admitted: boolean;
		const codeUnit =
			codeUnitReads === undefined
				? undefined
				: numericLoopCodeUnitRead(fn, ip, codeUnitReads);
		const data = dataViewCalls.get(ip);
		if (data !== undefined && instruction.opcode === "CALL") {
			const [key, value] = instruction.arguments;
			const littleEndian = instruction.arguments[data.set ? 2 : 1];
			// Like a code unit read's, the callee is the method the entry proved.
			admitted =
				intrinsics.has(instruction.callee) &&
				before.has(instruction.callee) &&
				read(key!, "number") &&
				(!data.set ||
					decodeVmValueOperand(value!).kind !== "register" ||
					read(value!, "number")) &&
				(littleEndian === undefined ||
					decodeVmValueOperand(littleEndian).kind !== "register" ||
					read(littleEndian)) &&
				(data.set || write(instruction.dst, "number"));
		} else if (codeUnit !== undefined) {
			// Every write of the callee loads the method from this receiver, so one this
			// iteration made it the builtin.
			admitted =
				intrinsics.has(codeUnit.callee) &&
				before.has(codeUnit.callee) &&
				read(codeUnit.key, "number") &&
				write(codeUnit.dst, "number");
		} else if (methods.has(ip) && instruction.opcode === "LOAD_PROPERTY_STATIC") {
			// Like an intrinsic, the method may only be the callee the next call ignores.
			admitted = !kinds.has(instruction.dst) && !inputs.has(instruction.dst);
			intrinsics.add(instruction.dst);
		} else
			switch (instruction.opcode) {
				case "CALL_KNOWN":
				case "MATH_UNARY_NUMBER":
				case "MATH_BINARY_NUMBER": {
					const builtin = nativeNumericBuiltinInstruction(instruction);
					admitted =
						builtin !== undefined &&
						builtin.arguments.every(
							(argument) =>
								argument.kind === "number" || read(argument.register, "number"),
						) &&
						write(instruction.dst, builtin.resultKind);
					break;
				}
				case "LOAD_PROPERTY":
					admitted =
						indexed &&
						read(instruction.key, "number") &&
						write(instruction.dst, "number");
					break;
				case "STORE_PROPERTY":
					admitted =
						indexed &&
						read(instruction.key, "number") &&
						read(instruction.value, "number");
					break;
				case "LOAD_PROPERTY_STATIC_ARRAY_LENGTH":
					admitted = indexed && write(instruction.dst, "number");
					break;
				case "REQUIRE_COERCIBLE":
					admitted = indexed;
					break;
				case "ITERATOR_STEP":
					admitted =
						indexed &&
						write(instruction.valueDst, "number") &&
						write(instruction.doneDst, "boolean");
					break;
				case "LOAD_PROPERTY_STATIC":
				case "CREATE_NUMBER":
				case "CREATE_F64":
					admitted = write(instruction.dst, "number");
					break;
				case "CREATE_BOOLEAN":
					admitted = write(instruction.dst, "boolean");
					break;
				// The load can neither collect nor throw, so the region performs it on the register
				// itself; inside, only a numeric builtin's ignored receiver may name that register.
				case "LOAD_INTRINSIC":
					admitted =
						!kinds.has(instruction.dst) &&
						!inputs.has(instruction.dst) &&
						!written.has(instruction.dst);
					intrinsics.add(instruction.dst);
					break;
				// A region neither calls out nor stores bindings, so the entry loads each binding
				// once into its register, which reads inside then see as an input.
				case "LOAD_GLOBAL":
				case "LOAD_CAPTURED":
					admitted = bindingLoads && representations[instruction.dst] === "boxed";
					bindings.add(instruction.dst);
					break;
				case "THROW_IF_TDZ":
					admitted = bindings.has(instruction.src);
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
		if (instruction.opcode !== "LOAD_GLOBAL" && instruction.opcode !== "LOAD_CAPTURED")
			for (const register of vmInstructionWriteRegisters(instruction))
				after.add(register);
		for (const successor of numberRecordSuccessors(instruction, ip))
			join(successor, after);
	}
	// A move into a register read as a Number reads its source as one too.
	for (let changed = true; changed;) {
		changed = false;
		for (const ip of order) {
			const instruction = fn.instructions[ip]!;
			if (
				instruction.opcode === "MOVE" &&
				numericReads.has(instruction.dst) &&
				!numericReads.has(instruction.src)
			) {
				numericReads.add(instruction.src);
				changed = true;
			}
		}
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
	inLoop: boolean,
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
	if (accesses < (inLoop ? 2 : 4) || fields.size > NUMBER_RECORD_FIELD_LIMIT)
		return undefined;
	if (![...fields.values()].some((field) => field.stored)) {
		const builtin = order.some(
			(ip) => nativeNumericBuiltinInstruction(fn.instructions[ip]!) !== undefined,
		);
		const arithmetic = order.some((ip) => {
			const instruction = fn.instructions[ip]!;
			return (
				instruction.opcode === "BINARY" &&
				NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator)
			);
		});
		// Existing pair/triple/quad projections already cover small linear read-only arithmetic.
		if (!builtin && ((!inLoop && accesses <= 4) || !arithmetic)) return undefined;
	}
	return Object.freeze([...fields.values()]);
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
	inLoop: boolean,
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
	if (closure.size < 4) return undefined;
	// Any member or closure exit can serve as the single exit of a smaller region.
	const candidates: Array<{
		readonly order: ReadonlyArray<number>;
		readonly exitIp: number;
		readonly fields: NativeNumberRecordRegionPlan["fields"];
	}> = [];
	for (const exitIp of [...closure, ...exits]) {
		if (exitIp === startIp || exitIp >= fn.instructions.length) continue;
		const order = numberRecordOrder(fn, startIp, exitIp, (ip) => closure.has(ip));
		const fields =
			order === undefined ? undefined : numberRecordFields(fn, order, inLoop);
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

const NUMERIC_LOOP_INSTRUCTION_LIMIT = 128;
const FIXED_NUMERIC_LOOP_ACCESS_LIMIT = 32;

/**
 * Exact and contained TypedArray accesses, which a fixed-numeric region replaces: its
 * entry admits each view's storage itself, so it needs neither access's proof.
 */
function typedArrayElementPlan(kind: NativeInstructionPlan["kind"] | undefined): boolean {
	return (
		kind === "exact-typed-array-element" || kind === "contained-fixed-typed-array-element"
	);
}

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

export interface NativeNumericLoopShape {
	readonly members: ReadonlySet<number>;
	/** Members in an order that visits each after its forward predecessors within one iteration. */
	readonly order: ReadonlyArray<number>;
	readonly entryIp: number;
	/** The header of each loop nested in this one, with that loop's members. */
	readonly inner: ReadonlyMap<number, ReadonlySet<number>>;
}

/**
 * The loop headed at `header` when control enters it only through one jump to the
 * header and its body is acyclic apart from the edges back to the header, or with
 * `nested`, apart from the back edges of reducible loops inside it.
 */
export function numericLoopShape(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	header: number,
	nested = false,
): NativeNumericLoopShape | undefined {
	if (body.externalEntries.has(header)) return undefined;
	const predecessors = bytecodePredecessors(fn, body, header);
	if (!predecessors.some((source) => source >= header)) return undefined;
	// A back edge leaves an instruction that every path from an entry reaches through the header.
	const outside = new Uint8Array(fn.instructions.length);
	const pending = [0, ...body.externalEntries];
	while (pending.length > 0) {
		let ip = pending.pop()!;
		while (ip !== header && ip < fn.instructions.length && outside[ip] !== 1) {
			outside[ip] = 1;
			const instruction = fn.instructions[ip]!;
			if (instruction.opcode === "RETURN" || instruction.opcode === "THROW") break;
			if (instruction.opcode === "JUMP") ip = instruction.targetIp;
			else {
				if (instruction.opcode === "JUMP_IF") pending.push(instruction.targetIp);
				ip++;
			}
		}
	}
	const members = new Set([header]);
	const backward = predecessors.filter((source) => outside[source] === 0);
	if (backward.length === 0) return undefined;
	while (backward.length > 0) {
		const ip = backward.pop()!;
		if (members.has(ip)) continue;
		if (members.size >= NUMERIC_LOOP_INSTRUCTION_LIMIT) return undefined;
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
	const order = numericLoopOrder(fn, header, members, nested);
	if (order === undefined) return undefined;
	const inner = numericLoopInnerBodies(fn, header, members, order);
	return inner === undefined ? undefined : { members, order, entryIp, inner };
}

/**
 * One iteration's members in topological order of its forward edges, when only edges
 * to the header close a cycle, or with `nested`, also edges back to an open inner header.
 */
export function numericLoopOrder(
	fn: BytecodeFunction,
	header: number,
	members: ReadonlySet<number>,
	nested = false,
): ReadonlyArray<number> | undefined {
	const state = new Map<number, "open" | "done">();
	const postorder: Array<number> = [];
	const visit = (ip: number): boolean => {
		const seen = state.get(ip);
		if (seen !== undefined) return seen === "done" || nested;
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

/**
 * Each inner loop's members, keyed by its header, when every edge against the order
 * targets a header that dominates its source, so the inner loops are reducible.
 */
export function numericLoopInnerBodies(
	fn: BytecodeFunction,
	header: number,
	members: ReadonlySet<number>,
	order: ReadonlyArray<number>,
): Map<number, Set<number>> | undefined {
	const position = new Map(order.map((ip, index) => [ip, index]));
	const predecessors = new Map<number, Array<number>>();
	for (const ip of order)
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			if (successor !== header && members.has(successor))
				predecessors.set(successor, [...(predecessors.get(successor) ?? []), ip]);
	const bodies = new Map<number, Set<number>>();
	for (const source of order)
		for (const target of numberRecordSuccessors(fn.instructions[source]!, source)) {
			if (
				target === header ||
				!members.has(target) ||
				position.get(target)! > position.get(source)!
			)
				continue;
			const reached = new Set<number>([header]);
			const pending = [header];
			while (pending.length > 0) {
				const ip = pending.pop()!;
				for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
					if (
						successor !== target &&
						successor !== header &&
						members.has(successor) &&
						!reached.has(successor)
					) {
						reached.add(successor);
						pending.push(successor);
					}
			}
			if (reached.has(source)) return undefined;
			const loop = bodies.get(target) ?? new Set([target]);
			const walk = [source];
			while (walk.length > 0) {
				const ip = walk.pop()!;
				if (loop.has(ip)) continue;
				loop.add(ip);
				walk.push(...(predecessors.get(ip) ?? []));
			}
			bodies.set(target, loop);
		}
	return bodies;
}

/** A register's value as `scale * index + offset`, or the constant `offset`. */
type NumericLoopIndexFact =
	| { readonly base: "constant"; readonly offset: number }
	| { readonly base: "index"; readonly scale: number; readonly offset: number };

/** A DataView key's bytes per index step; the bound keeps every byte key an exact double. */
const NUMERIC_LOOP_BYTE_SCALE_LIMIT = 0x10000;

function numericLoopOffset(value: number): boolean {
	return Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
}

/** Loop invariants whose last write on the entry path is an offset-sized integer constant. */
function numericLoopEntryConstants(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	shape: NativeNumericLoopShape,
): Map<number, number> {
	const seen = new Set(
		shape.order.flatMap((ip) => vmInstructionWriteRegisters(fn.instructions[ip]!)),
	);
	const constants = new Map<number, number>();
	let cursor = shape.entryIp;
	const visited = new Set<number>();
	// Only a unique predecessor chain proves hoisted constants on every entry path.
	for (let work = 0; work < NUMERIC_LOOP_INSTRUCTION_LIMIT; work++) {
		if (body.externalEntries.has(cursor)) break;
		const predecessors = bytecodePredecessors(fn, body, cursor);
		if (predecessors.length !== 1) break;
		const ip = predecessors[0]!;
		if (shape.members.has(ip) || visited.has(ip)) break;
		visited.add(ip);
		const op = fn.instructions[ip]!;
		for (const register of vmInstructionWriteRegisters(op)) {
			if (seen.has(register)) continue;
			seen.add(register);
			if (
				(op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64") &&
				numericLoopOffset(op.value)
			)
				constants.set(register, op.value);
		}
		cursor = ip;
	}
	// A constant hoisted past an enclosing loop's header is still the register's only
	// write, and the function's entry chain runs it before anything else.
	for (const ip of shape.order)
		for (const register of vmInstructionReadRegisters(fn.instructions[ip]!)) {
			if (seen.has(register)) continue;
			seen.add(register);
			const writerIp = singleWriters(body).get(register);
			const writer = writerIp === undefined ? undefined : fn.instructions[writerIp];
			if (
				register >= fn.parameterCount &&
				(writer?.opcode === "CREATE_NUMBER" || writer?.opcode === "CREATE_F64") &&
				numericLoopOffset(writer.value) &&
				functionEntryChain(fn, body).has(writerIp!)
			)
				constants.set(register, writer.value);
		}
	return constants;
}

const singleWriterCache = new WeakMap<NativeBodyFacts, ReadonlyMap<number, number>>();

/** Each register written by exactly one instruction, with that instruction. */
function singleWriters(body: NativeBodyFacts): ReadonlyMap<number, number> {
	const cached = singleWriterCache.get(body);
	if (cached !== undefined) return cached;
	const writers = new Map<number, number>();
	const repeated = new Set<number>();
	for (const [ip, written] of body.writes.entries())
		for (const register of written) {
			if (writers.has(register)) repeated.add(register);
			writers.set(register, ip);
		}
	for (const register of repeated) writers.delete(register);
	singleWriterCache.set(body, writers);
	return writers;
}

const entryChainCache = new WeakMap<NativeBodyFacts, ReadonlySet<number>>();

/**
 * The instructions every execution runs first, in order: from the only entry, each has
 * a single predecessor, no handler, and no branch until the chain ends.
 */
function functionEntryChain(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
): ReadonlySet<number> {
	const cached = entryChainCache.get(body);
	if (cached !== undefined) return cached;
	const chain = new Set<number>();
	if ([...body.externalEntries].every((ip) => ip === 0))
		for (let ip = 0; ip < fn.instructions.length && !chain.has(ip);) {
			if (
				body.handlerTargets[ip] !== undefined ||
				bytecodePredecessors(fn, body, ip).length !== (ip === 0 ? 0 : 1)
			)
				break;
			chain.add(ip);
			const op = fn.instructions[ip]!;
			if (op.opcode === "JUMP") ip = op.targetIp;
			else if (op.opcode === "JUMP_IF" || op.opcode === "RETURN" || op.opcode === "THROW")
				break;
			else ip++;
		}
	entryChainCache.set(body, chain);
	return chain;
}

/** A write of `src` plus a constant, as `+`, `-`, increment or decrement. */
function numericLoopConstantStep(
	op: BytecodeInstruction,
	constants: ReadonlyMap<number, number>,
): { readonly dst: number; readonly src: number; readonly offset: number } | undefined {
	if (
		op.opcode === "UNARY" &&
		(op.operator === "increment" || op.operator === "decrement")
	)
		return { dst: op.dst, src: op.src, offset: op.operator === "increment" ? 1 : -1 };
	if (op.opcode !== "BINARY" || (op.operator !== "+" && op.operator !== "-"))
		return undefined;
	const right = constants.get(op.right);
	if (right !== undefined)
		return { dst: op.dst, src: op.left, offset: op.operator === "+" ? right : -right };
	const left = constants.get(op.left);
	return left !== undefined && op.operator === "+"
		? { dst: op.dst, src: op.right, offset: left }
		: undefined;
}

function numericLoopIndexFacts(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	shape: NativeNumericLoopShape,
	index: number,
	keys: ReadonlyMap<number, number>,
): {
	/** Keys at the index plus an offset. */
	readonly offsets: ReadonlyMap<number, number>;
	/** Keys at any positive multiple of the index plus an offset. */
	readonly windows: ReadonlyMap<
		number,
		{ readonly scale: number; readonly offset: number }
	>;
	readonly increments: ReadonlyMap<number, number>;
} {
	const initial = new Map<number, NumericLoopIndexFact>([
		...[...numericLoopEntryConstants(fn, body, shape)].map(
			([register, offset]): [number, NumericLoopIndexFact] => [
				register,
				{ base: "constant", offset },
			],
		),
		[index, { base: "index", scale: 1, offset: 0 }],
	]);
	const before = new Map<number, Map<number, NumericLoopIndexFact>>([
		[shape.order[0]!, initial],
	]);
	const offsets = new Map<number, number>();
	const windows = new Map<number, { scale: number; offset: number }>();
	const increments = new Map<number, number>();
	for (const ip of shape.order) {
		const facts = new Map(before.get(ip));
		// Its forward predecessors miss what the inner loop's own iterations write.
		for (const member of shape.inner.get(ip) ?? [])
			for (const register of vmInstructionWriteRegisters(fn.instructions[member]!))
				facts.delete(register);
		const op = fn.instructions[ip]!;
		const keyRegister = keys.get(ip);
		if (keyRegister !== undefined) {
			const key = facts.get(keyRegister);
			if (key?.base === "index") {
				windows.set(ip, { scale: key.scale, offset: key.offset });
				if (key.scale === 1) offsets.set(ip, key.offset);
			}
		}
		let result: NumericLoopIndexFact | undefined;
		if (
			(op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64") &&
			numericLoopOffset(op.value)
		)
			result = { base: "constant", offset: op.value };
		else if (
			op.opcode === "MOVE" ||
			(op.opcode === "UNARY" && (op.operator === "tonumeric" || op.operator === "+"))
		)
			result = facts.get(op.src);
		else if (
			op.opcode === "UNARY" &&
			(op.operator === "increment" || op.operator === "decrement")
		) {
			const source = facts.get(op.src);
			const step = op.operator === "increment" ? 1 : -1;
			if (source !== undefined && numericLoopOffset(source.offset + step))
				result = { ...source, offset: source.offset + step };
		} else if (op.opcode === "BINARY" && (op.operator === "+" || op.operator === "-")) {
			const left = facts.get(op.left),
				right = facts.get(op.right);
			if (
				left !== undefined &&
				right !== undefined &&
				(right.base === "constant" || (left.base === "constant" && op.operator === "+"))
			) {
				const offset =
					op.operator === "+" ? left.offset + right.offset : left.offset - right.offset;
				const indexed =
					left.base === "index" ? left : right.base === "index" ? right : undefined;
				if (numericLoopOffset(offset))
					result =
						indexed === undefined
							? { base: "constant", offset }
							: { base: "index", scale: indexed.scale, offset };
			}
		} else if (op.opcode === "BINARY" && op.operator === "*") {
			const left = facts.get(op.left),
				right = facts.get(op.right);
			const factor =
				right?.base === "constant" ? right : left?.base === "constant" ? left : undefined;
			const scaled = factor === right ? left : right;
			const offset = (scaled?.offset ?? 0) * (factor?.offset ?? 0);
			if (
				factor !== undefined &&
				scaled !== undefined &&
				factor.offset > 0 &&
				numericLoopOffset(offset)
			)
				result =
					scaled.base === "constant"
						? { base: "constant", offset }
						: scaled.scale * factor.offset <= NUMERIC_LOOP_BYTE_SCALE_LIMIT
							? { base: "index", scale: scaled.scale * factor.offset, offset }
							: undefined;
		}
		if (
			result?.base === "index" &&
			result.scale === 1 &&
			result.offset !== 0 &&
			(op.opcode === "BINARY" ||
				(op.opcode === "UNARY" &&
					(op.operator === "increment" || op.operator === "decrement")))
		)
			increments.set(ip, result.offset);
		for (const register of vmInstructionWriteRegisters(op)) facts.delete(register);
		if (result !== undefined && "dst" in op) facts.set(op.dst, result);
		for (const successor of numberRecordSuccessors(op, ip)) {
			if (successor === shape.order[0] || !shape.members.has(successor)) continue;
			const incoming = before.get(successor);
			if (incoming === undefined) before.set(successor, new Map(facts));
			else
				for (const [register, fact] of incoming) {
					const other = facts.get(register);
					if (
						other?.base !== fact.base ||
						other.offset !== fact.offset ||
						(other.base === "index" &&
							fact.base === "index" &&
							other.scale !== fact.scale)
					)
						incoming.delete(register);
				}
		}
	}
	return { offsets, windows, increments };
}

/** Only proven builtin identities whose numeric bodies cannot call user code or collect. */
export function nativeNumericBuiltinInstruction(instruction: BytecodeInstruction):
	| {
			readonly operation: string;
			readonly resultKind: NativeNumberRecordKind;
			readonly arguments: ReadonlyArray<
				Extract<DecodedVmValueOperand, { kind: "register" | "number" }>
			>;
	  }
	| undefined {
	if (instruction.opcode === "MATH_UNARY_NUMBER")
		return {
			operation: instruction.operation,
			resultKind: "number",
			arguments: [{ kind: "register", register: instruction.src }],
		};
	if (instruction.opcode === "MATH_BINARY_NUMBER")
		return {
			operation: instruction.operation,
			resultKind: "number",
			arguments: [
				{ kind: "register", register: instruction.left },
				{ kind: "register", register: instruction.right },
			],
		};
	if (
		instruction.opcode !== "CALL_KNOWN" ||
		instruction.construct ||
		instruction.argumentMode !== undefined ||
		(instruction.specialized !== undefined &&
			(!NUMBER_PREDICATES.has(instruction.operation) ||
				instruction.specialized !== instruction.operation))
	)
		return undefined;
	if (NUMBER_PREDICATES.has(instruction.operation)) {
		const first = instruction.arguments[0];
		const argument = first === undefined ? undefined : decodeVmValueOperand(first);
		return {
			operation: instruction.operation,
			resultKind: "boolean",
			arguments:
				argument?.kind === "register" || argument?.kind === "number" ? [argument] : [],
		};
	}
	const arity = nativeMathNumberArity(
		instruction.operation,
		instruction.arguments.length,
	);
	if (arity === undefined) return undefined;
	const arguments_ = Array.from({ length: arity }, (_, index) => {
		const operand = instruction.arguments[index];
		const value =
			operand === undefined
				? { kind: "undefined" as const }
				: decodeVmValueOperand(operand);
		if (value.kind === "undefined") return { kind: "number" as const, value: NaN };
		if (value.kind === "null" || value.kind === "boolean")
			return {
				kind: "number" as const,
				value: value.kind === "boolean" && value.value ? 1 : 0,
			};
		return value;
	});
	return arguments_.every(
		(argument) => argument.kind === "register" || argument.kind === "number",
	)
		? { operation: instruction.operation, resultKind: "number", arguments: arguments_ }
		: undefined;
}

/**
 * Element registers whose every use reads one of the element's own fields or moves
 * it to another such register; anything else keeps the element a Number.
 */
function numericLoopRecords(
	fn: BytecodeFunction,
	shape: NativeNumericLoopShape,
	elements: ReadonlyArray<number>,
): Set<number> | undefined {
	const writers = new Map<number, number>();
	for (const ip of shape.order)
		for (const register of vmInstructionWriteRegisters(fn.instructions[ip]!))
			writers.set(register, (writers.get(register) ?? 0) + 1);
	const candidates = new Set<number>();
	for (const register of elements)
		if (writers.get(register) === 1) candidates.add(register);
	for (let changed = true; changed;) {
		changed = false;
		for (const ip of shape.order) {
			const op = fn.instructions[ip]!;
			if (
				op.opcode === "MOVE" &&
				candidates.has(op.src) &&
				!candidates.has(op.dst) &&
				writers.get(op.dst) === 1
			) {
				candidates.add(op.dst);
				changed = true;
			}
		}
	}
	const fieldReads = new Set<number>();
	for (const ip of shape.order) {
		const op = fn.instructions[ip]!;
		for (const register of vmInstructionReadRegisters(op)) {
			if (!candidates.has(register)) continue;
			if (op.opcode === "LOAD_PROPERTY_STATIC" && op.object === register) {
				fieldReads.add(register);
				continue;
			}
			if (op.opcode === "MOVE" && candidates.has(op.dst)) continue;
			// Destructuring's check passes for every element the region admits as an object.
			if (op.opcode === "REQUIRE_COERCIBLE") continue;
			candidates.delete(register);
		}
	}
	// A dropped candidate may have been the source of a kept move.
	for (const ip of shape.order) {
		const op = fn.instructions[ip]!;
		if (op.opcode === "MOVE" && candidates.has(op.dst) && !candidates.has(op.src))
			return undefined;
	}
	for (const register of candidates)
		if (
			!fieldReads.has(register) &&
			!shape.order.some((ip) => {
				const op = fn.instructions[ip]!;
				return op.opcode === "MOVE" && op.src === register;
			})
		)
			candidates.delete(register);
	return candidates;
}

/** The index a counted loop compares and steps, with each access's offset from it. */
function fixedNumericLoopCounter(
	fn: BytecodeFunction,
	shape: NativeNumericLoopShape,
	body: NativeBodyFacts,
	lengthLoads: ReadonlySet<number>,
	memory: ReadonlyArray<NumericLoopAccess>,
):
	| {
			readonly counter: NativeNumericLoopCounter;
			readonly offsets: ReadonlyMap<number, number>;
			readonly windows: ReadonlyMap<
				number,
				{ readonly scale: number; readonly offset: number }
			>;
			readonly lengthLoad?: {
				readonly ip: number;
				readonly object: number;
				readonly dst: number;
			};
	  }
	| undefined {
	// Before comparing, the header may reload a view's length, which no region instruction
	// can change, and step either operand by a constant, as `i + 1 < a.length` does.
	const constants = numericLoopEntryConstants(fn, body, shape);
	let lengthLoad: { ip: number; object: number; dst: number } | undefined;
	let step: { ip: number; dst: number; src: number; offset: number } | undefined;
	let comparisonIp: number | undefined;
	for (const [position, ip] of shape.order.slice(0, 4).entries()) {
		const op = fn.instructions[ip]!;
		if (ip !== shape.order[0]! + position) return undefined;
		if (op.opcode === "BINARY" && ["<", "<=", ">", ">="].includes(op.operator)) {
			comparisonIp = ip;
			break;
		}
		if (
			lengthLoad === undefined &&
			lengthLoads.has(ip) &&
			(op.opcode === "LOAD_PROPERTY_STATIC" ||
				op.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
		) {
			lengthLoad = { ip, object: op.object, dst: op.dst };
			continue;
		}
		if (
			(op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64") &&
			numericLoopOffset(op.value)
		) {
			constants.set(op.dst, op.value);
			continue;
		}
		const constantStep =
			step === undefined ? numericLoopConstantStep(op, constants) : undefined;
		if (constantStep === undefined) return undefined;
		step = { ip, ...constantStep };
	}
	const comparison =
		comparisonIp === undefined ? undefined : fn.instructions[comparisonIp];
	if (comparisonIp === undefined || comparison?.opcode !== "BINARY") return undefined;
	if (
		step !== undefined &&
		((comparison.left !== step.dst && comparison.right !== step.dst) ||
			shape.order.some((ip) => ip !== step.ip && body.writes[ip]!.includes(step.dst)))
	)
		return undefined;
	const operand = (register: number) =>
		register === step?.dst
			? { register: step.src, offset: step.offset }
			: { register, offset: 0 };
	const writtenInLoop = (register: number) =>
		shape.order.some(
			(ip) => ip !== lengthLoad?.ip && body.writes[ip]!.includes(register),
		);
	const left = operand(comparison.left);
	const right = operand(comparison.right);
	const leftWritten = writtenInLoop(left.register);
	const rightWritten = writtenInLoop(right.register);
	if (leftWritten === rightWritten) return undefined;
	const index = leftWritten ? left.register : right.register;
	const bound = leftWritten ? right.register : left.register;
	// `index + a < bound + b` continues exactly while `index < bound + (b - a)`.
	const limitOffset = leftWritten
		? right.offset - left.offset
		: left.offset - right.offset;
	if (!numericLoopOffset(limitOffset)) return undefined;
	if (lengthLoad !== undefined && bound !== lengthLoad.dst) return undefined;
	const branch = fn.instructions[comparisonIp + 1];
	if (
		branch?.opcode !== "JUMP_IF" ||
		branch.cond !== comparison.dst ||
		!shape.members.has(branch.targetIp) ||
		shape.members.has(comparisonIp + 2)
	)
		return undefined;
	const { offsets, windows, increments } = numericLoopIndexFacts(
		fn,
		body,
		shape,
		index,
		new Map(memory.map((access) => [access.ip, access.op.key])),
	);
	const indexWrites = shape.order.filter((ip) =>
		vmInstructionWriteRegisters(fn.instructions[ip]!).includes(index),
	);
	if (indexWrites.length !== 1) return undefined;
	const update = fn.instructions[indexWrites[0]!]!;
	if (update.opcode !== "MOVE") return undefined;
	const candidates = [...increments].filter(([ip]) => {
		const op = fn.instructions[ip]!;
		return "dst" in op && op.dst === update.src;
	});
	if (candidates.length !== 1) return undefined;
	const [incrementIp, stride] = candidates[0]!;
	if (
		[...shape.inner.values()].some(
			(loop) => loop.has(incrementIp) || loop.has(indexWrites[0]!),
		)
	)
		return undefined;
	const ascending = leftWritten
		? comparison.operator === "<" || comparison.operator === "<="
		: comparison.operator === ">" || comparison.operator === ">=";
	if (ascending !== stride > 0) return undefined;
	const increment = fn.instructions[incrementIp]!;
	if (!("dst" in increment) || increment.dst === index) return undefined;
	if (
		update.src !== increment.dst ||
		shape.order.indexOf(indexWrites[0]!) <= shape.order.indexOf(incrementIp)
	)
		return undefined;
	// Every access sees this iteration's index, so none may follow the increment.
	const afterIncrement = new Set<number>();
	const following = numberRecordSuccessors(increment, incrementIp);
	while (following.length > 0) {
		const ip = following.pop()!;
		if (ip === shape.order[0] || !shape.members.has(ip) || afterIncrement.has(ip))
			continue;
		afterIncrement.add(ip);
		following.push(...numberRecordSuccessors(fn.instructions[ip]!, ip));
	}
	if (memory.some(({ ip }) => afterIncrement.has(ip))) return undefined;
	if (
		shape.order.some(
			(ip) =>
				ip !== incrementIp &&
				vmInstructionWriteRegisters(fn.instructions[ip]!).includes(increment.dst),
		)
	)
		return undefined;
	for (const required of [incrementIp, indexWrites[0]!]) {
		const pending = [branch.targetIp],
			seen = new Set<number>();
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (ip === shape.order[0]) return undefined;
			if (ip === required || seen.has(ip) || !shape.members.has(ip)) continue;
			seen.add(ip);
			pending.push(...numberRecordSuccessors(fn.instructions[ip]!, ip));
		}
	}
	return {
		counter: {
			index,
			bound,
			...(lengthLoad === undefined ? {} : { boundObject: lengthLoad.object }),
			comparison: comparisonIp,
			limitOffset,
			stride,
		},
		offsets,
		windows,
		...(lengthLoad === undefined ? {} : { lengthLoad }),
	};
}

interface NumericLoopAccess {
	readonly ip: number;
	readonly op:
		| Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY" | "STORE_PROPERTY" }>
		| {
				readonly opcode: "LOAD_PROPERTY";
				readonly object: number;
				readonly key: number;
				readonly dst: number;
		  }
		| {
				readonly opcode: "STORE_PROPERTY";
				readonly object: number;
				readonly key: number;
				readonly value: number;
		  };
	readonly text?: true;
	readonly data?: NativeDataViewCall;
}

/**
 * Calls whose callee every write loads from the call's receiver by a DataView accessor's
 * name; a region's entry proves that name selects the intrinsic.
 */
function numericLoopDataViewCalls(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	callPlan: (ip: number) => NativeInstructionPlan | undefined,
): ReadonlyMap<number, NativeDataViewCall> {
	const writers = new Map<number, Array<BytecodeInstruction>>();
	for (const op of fn.instructions)
		for (const register of vmInstructionWriteRegisters(op)) {
			const registerWriters = writers.get(register);
			if (registerWriters === undefined) writers.set(register, [op]);
			else registerWriters.push(op);
		}
	const calls = new Map<number, NativeDataViewCall>();
	for (const [ip, call] of fn.instructions.entries()) {
		if (call.opcode !== "CALL" || call.callee === call.thisValue) continue;
		const names = new Set(
			(writers.get(call.callee) ?? []).map((writer) =>
				writer.opcode === "LOAD_PROPERTY_STATIC" && writer.object === call.thisValue
					? String.fromCharCode(...(stringConstants[writer.stringIndex] ?? []))
					: undefined,
			),
		);
		const [method] = names;
		const accessor =
			names.size === 1 && method !== undefined
				? nativeDataViewAccessor(method)
				: undefined;
		const plan = callPlan(ip);
		const [key, value] = call.arguments;
		const littleEndian = call.arguments[accessor?.set === true ? 2 : 1];
		if (
			accessor === undefined ||
			(plan !== undefined &&
				(plan.kind !== "call" ||
					plan.guardedBuiltinCall?.operation !== `DataView.prototype.${method}`)) ||
			call.arguments.length < (accessor.set ? 2 : 1) ||
			call.arguments.length > (accessor.set ? 3 : 2) ||
			// Keys are counted registers; a stored value is a Number, and the region folds a
			// constant byte order, which no string spells.
			key === undefined ||
			decodeVmValueOperand(key).kind !== "register" ||
			(accessor.set &&
				decodeVmValueOperand(value!).kind !== "register" &&
				decodeVmValueOperand(value!).kind !== "number") ||
			(littleEndian !== undefined &&
				decodeVmValueOperand(littleEndian).kind === "string") ||
			// A setter's result is undefined, which no region register holds.
			(accessor.set && registersLiveAt(fn, body, ip + 1, new Set([call.dst])).length > 0)
		)
			continue;
		calls.set(ip, { ip, ...accessor });
	}
	return calls;
}

/** The `charCodeAt` call at `ip` as a read of its receiver's code unit. */
function numericLoopCodeUnitRead(
	fn: BytecodeFunction,
	ip: number,
	codeUnitReads: ReadonlySet<number>,
):
	| {
			readonly object: number;
			readonly key: number;
			readonly dst: number;
			readonly callee: number;
	  }
	| undefined {
	const call = fn.instructions[ip];
	return codeUnitReads.has(ip) && call?.opcode === "CALL" && call.arguments.length === 1
		? {
				object: call.thisValue,
				key: call.arguments[0]!,
				dst: call.dst,
				callee: call.callee,
			}
		: undefined;
}

/**
 * The loads whose only use is as the callee of a code unit read or DataView accessor
 * call, which a region skips.
 */
export function numericLoopCallMethods(
	fn: BytecodeFunction,
	order: ReadonlyArray<number>,
	codeUnitReads: ReadonlySet<number>,
	dataViewCalls: ReadonlyMap<number, NativeDataViewCall> = new Map(),
): ReadonlySet<number> {
	const callees = new Set(
		order.flatMap((ip) => {
			const call = fn.instructions[ip];
			if (dataViewCalls.has(ip) && call?.opcode === "CALL") return [call.callee];
			const read = numericLoopCodeUnitRead(fn, ip, codeUnitReads);
			return read === undefined ? [] : [read.callee];
		}),
	);
	return new Set(
		order.filter((ip) => {
			const op = fn.instructions[ip]!;
			return op.opcode === "LOAD_PROPERTY_STATIC" && callees.has(op.dst);
		}),
	);
}

/**
 * Registers a loop loads from globals or enclosing functions' bindings, which its region
 * loads once at entry: nothing in a region calls out or stores a binding.
 */
function numericLoopBindings(
	fn: BytecodeFunction,
	shape: NativeNumericLoopShape,
	body: NativeBodyFacts,
): ReadonlySet<number> | undefined {
	const bindings = new Set<number>();
	for (const ip of shape.order) {
		const op = fn.instructions[ip]!;
		if (op.opcode !== "LOAD_GLOBAL" && op.opcode !== "LOAD_CAPTURED") continue;
		// A function's own capture environment may not exist yet where the loop starts.
		if (
			op.opcode === "LOAD_CAPTURED" &&
			(fn.capturedCount > 0 || op.ownerFunctionIndex < 0)
		)
			return undefined;
		if (
			shape.order.some(
				(other) =>
					other !== ip &&
					vmInstructionWriteRegisters(fn.instructions[other]!).includes(op.dst),
			)
		)
			return undefined;
		bindings.add(op.dst);
	}
	// The entry loads each binding into its register, which only a header that read the
	// register before reloading it could observe.
	return registersLiveAt(fn, body, shape.order[0]!, bindings).length > 0
		? undefined
		: bindings;
}

function fixedNumericLoopStorage(
	fn: BytecodeFunction,
	shape: NativeNumericLoopShape,
	body: NativeBodyFacts,
	lengthLoads: ReadonlySet<number>,
	codeUnitReads: ReadonlySet<number>,
	dataViewCalls: ReadonlyMap<number, NativeDataViewCall>,
):
	| Pick<
			Extract<NativeNumericLoopRegionPlan, { kind: "fixed-numeric" }>,
			"counter" | "records" | "views" | "dataViewCalls"
	  >
	| undefined {
	const memory = shape.order.flatMap((ip): Array<NumericLoopAccess> => {
		const op = fn.instructions[ip]!;
		if (op.opcode === "LOAD_PROPERTY" || op.opcode === "STORE_PROPERTY")
			return [{ ip, op }];
		const data = dataViewCalls.get(ip);
		if (data !== undefined && op.opcode === "CALL") {
			const [key, value] = op.arguments;
			return [
				{
					ip,
					op: data.set
						? { opcode: "STORE_PROPERTY", object: op.thisValue, key: key!, value: value! }
						: { opcode: "LOAD_PROPERTY", object: op.thisValue, key: key!, dst: op.dst },
					data,
				},
			];
		}
		const read = numericLoopCodeUnitRead(fn, ip, codeUnitReads);
		return read === undefined
			? []
			: [{ ip, op: { opcode: "LOAD_PROPERTY", ...read }, text: true }];
	});
	const methodLoads = numericLoopCallMethods(
		fn,
		shape.order,
		codeUnitReads,
		dataViewCalls,
	);
	if (memory.length === 0 || memory.length > FIXED_NUMERIC_LOOP_ACCESS_LIMIT)
		return undefined;
	const counted = fixedNumericLoopCounter(fn, shape, body, lengthLoads, memory);
	const offsets = counted?.offsets ?? new Map<number, number>();
	const windows =
		counted?.windows ?? new Map<number, { scale: number; offset: number }>();
	const lengthLoad = counted?.lengthLoad;
	const bound = counted?.counter.bound;
	const views = new Map<
		number,
		{
			writable: boolean;
			minOffset: number;
			maxOffset: number;
			checked?: true;
			text?: true;
			byteScale?: number;
		}
	>();
	for (const { ip, op, text, data } of memory) {
		const offset = offsets.get(ip);
		const previous = views.get(op.object);
		// One admission decides whether a view is a string, a DataView or an element view.
		if (
			previous !== undefined &&
			((previous.text === true) !== (text === true) ||
				(previous.byteScale !== undefined) !== (data !== undefined))
		)
			return undefined;
		if (data !== undefined) {
			// Entry guards prove every byte in range, so a DataView key needs a counted window.
			const window = windows.get(ip);
			if (
				window === undefined ||
				(previous?.byteScale !== undefined && previous.byteScale !== window.scale)
			)
				return undefined;
			const last = window.offset + DATA_VIEW_ELEMENT_SIZES[data.type] - 1;
			if (!numericLoopOffset(last)) return undefined;
			views.set(op.object, {
				writable: previous?.writable === true || data.set,
				minOffset: Math.min(previous?.minOffset ?? window.offset, window.offset),
				maxOffset: Math.max(previous?.maxOffset ?? last, last),
				byteScale: window.scale,
			});
			continue;
		}
		// Without a counter, every access is a read that checks its own key. Stores stay
		// at counted keys, whose range the entry guards prove even in a checked view.
		if (offset === undefined) {
			if (op.opcode !== "LOAD_PROPERTY") return undefined;
			views.set(op.object, {
				writable: previous?.writable === true,
				minOffset: previous?.minOffset ?? 0,
				maxOffset: previous?.maxOffset ?? 0,
				checked: true,
				...(text === true ? { text: true as const } : {}),
			});
			continue;
		}
		views.set(op.object, {
			writable: previous?.writable === true || op.opcode === "STORE_PROPERTY",
			minOffset: Math.min(previous?.minOffset ?? offset, offset),
			maxOffset: Math.max(previous?.maxOffset ?? offset, offset),
			...(previous?.checked === true ? { checked: true as const } : {}),
			...(text === true ? { text: true as const } : {}),
		});
	}
	// A failed checked read restarts the iteration in the original code, which would
	// repeat any store the iteration already made.
	const afterStores = new Set<number>();
	const pending = memory.flatMap(({ ip, op }) =>
		op.opcode === "STORE_PROPERTY"
			? numberRecordSuccessors(fn.instructions[ip]!, ip)
			: [],
	);
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (ip === shape.order[0] || !shape.members.has(ip) || afterStores.has(ip)) continue;
		afterStores.add(ip);
		pending.push(...numberRecordSuccessors(fn.instructions[ip]!, ip));
	}
	// Counted DataView reads never restart; entry guards proved their bytes.
	if (
		memory.some(
			({ ip, op, data }) =>
				op.opcode === "LOAD_PROPERTY" &&
				data === undefined &&
				!offsets.has(ip) &&
				afterStores.has(ip),
		)
	)
		return undefined;
	const bindings = numericLoopBindings(fn, shape, body);
	if (bindings === undefined) return undefined;
	const textual = new Set(memory.map((access) => access.text === true));
	if (lengthLoad !== undefined && !views.has(lengthLoad.object)) {
		// A length bound whose object no access reads takes the kind of every other view.
		if (textual.size > 1) return undefined;
		views.set(lengthLoad.object, {
			writable: false,
			minOffset: 0,
			maxOffset: 0,
			...(textual.has(true) ? { text: true as const } : {}),
		});
	}
	const records = numericLoopRecords(
		fn,
		shape,
		memory.flatMap(({ op, text, data }) =>
			op.opcode === "LOAD_PROPERTY" && text !== true && data === undefined
				? [op.dst]
				: [],
		),
	);
	const dataViews = [...views.values()].some((view) => view.byteScale !== undefined);
	// Record regions admit Array views only, never string spans; DataViews admit with
	// element views, never alongside strings or Arrays.
	if (
		records === undefined ||
		(records.size > 0 && (textual.has(true) || dataViews)) ||
		(dataViews &&
			(textual.has(true) ||
				fn.instructions[lengthLoad?.ip ?? -1]?.opcode ===
					"LOAD_PROPERTY_STATIC_ARRAY_LENGTH")) ||
		// A DataView has no `length` the region could bound by.
		(lengthLoad !== undefined && views.get(lengthLoad.object)?.byteScale !== undefined)
	)
		return undefined;
	// Stores admit only TypedArray views, whose length no store changes; records and
	// a known Array length need Array views, which stay read-only so stores keep their kinds.
	if (
		(records.size > 0 ||
			fn.instructions[lengthLoad?.ip ?? -1]?.opcode ===
				"LOAD_PROPERTY_STATIC_ARRAY_LENGTH") &&
		[...views.values()].some((view) => view.writable)
	)
		return undefined;
	if (
		views.size > 8 ||
		(counted !== undefined && (views.has(counted.counter.index) || views.has(bound!)))
	)
		return undefined;
	const viewCalls = new Set(
		memory.flatMap((access) =>
			access.text === true || access.data !== undefined ? [access.ip] : [],
		),
	);
	for (const ip of shape.order) {
		if (ip === lengthLoad?.ip) continue;
		const op = fn.instructions[ip]!;
		if (viewCalls.has(ip)) {
			if (
				vmInstructionWriteRegisters(op).some(
					(register) => register === bound || views.has(register),
				)
			)
				return undefined;
			continue;
		}
		// Only the view calls use the method, so the region need not produce it.
		if (methodLoads.has(ip) && op.opcode === "LOAD_PROPERTY_STATIC") {
			if (
				shape.order.some(
					(other) =>
						!viewCalls.has(other) &&
						vmInstructionReadRegisters(fn.instructions[other]!).includes(op.dst),
				)
			)
				return undefined;
			continue;
		}
		if (op.opcode === "LOAD_PROPERTY_STATIC" && records.has(op.object)) continue;
		if (op.opcode === "REQUIRE_COERCIBLE" && records.has(op.src)) continue;
		// The entry declines a binding still in its temporal dead zone.
		if (
			op.opcode === "LOAD_GLOBAL" ||
			op.opcode === "LOAD_CAPTURED" ||
			(op.opcode === "THROW_IF_TDZ" && bindings.has(op.src))
		)
			continue;
		if (
			vmInstructionWriteRegisters(op).some(
				(register) => register === bound || views.has(register),
			)
		)
			return undefined;
		if (op.opcode === "LOAD_PROPERTY" || op.opcode === "STORE_PROPERTY") continue;
		if (
			(op.opcode !== "CREATE_NUMBER" &&
				op.opcode !== "CREATE_F64" &&
				!integerLoopInstruction(op) &&
				nativeNumericBuiltinInstruction(op) === undefined) ||
			vmInstructionReadRegisters(op).some((register) => views.has(register))
		)
			return undefined;
	}
	const calls = memory.flatMap(({ data }) => (data === undefined ? [] : [data]));
	return {
		...(counted === undefined ? {} : { counter: counted.counter }),
		...(records.size === 0 ? {} : { records: [...records].sort((a, b) => a - b) }),
		views: [...views].map(([object, window]) => ({ object, ...window })),
		...(calls.length === 0 ? {} : { dataViewCalls: calls }),
	};
}

function lowerArrayIterationRegion(
	fn: BytecodeFunction,
	header: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	body: NativeBodyFacts,
	conflicts: (ip: number) => boolean,
	cursor: { readonly initializeIp: number; readonly iterator: number },
): NativeNumericLoopRegionPlan | undefined {
	const step = fn.instructions[header]!;
	if (step.opcode !== "ITERATOR_STEP" || conflicts(header)) return undefined;
	const shape = numericLoopShape(fn, body, header);
	if (shape === undefined || conflicts(shape.entryIp) || shape.order.some(conflicts))
		return undefined;
	const branch = fn.instructions[header + 1];
	if (
		branch?.opcode !== "JUMP_IF" ||
		branch.cond !== step.doneDst ||
		shape.members.has(branch.targetIp) ||
		!shape.members.has(header + 2)
	)
		return undefined;
	if (
		shape.order.some((ip) =>
			vmInstructionWriteRegisters(fn.instructions[ip]!).some(
				(register) => register === step.iterator || register === step.next,
			),
		)
	)
		return undefined;
	const records = numericLoopRecords(fn, shape, [step.valueDst]);
	if (records === undefined) return undefined;
	for (const ip of shape.order) {
		if (ip === header) continue;
		const op = fn.instructions[ip]!;
		if (op.opcode === "LOAD_PROPERTY_STATIC" && records.has(op.object)) continue;
		if (op.opcode === "REQUIRE_COERCIBLE" && records.has(op.src)) continue;
		if (
			(op.opcode !== "CREATE_NUMBER" &&
				op.opcode !== "CREATE_F64" &&
				!integerLoopInstruction(op) &&
				nativeNumericBuiltinInstruction(op) === undefined) ||
			vmInstructionReadRegisters(op).some(
				(register) => register === step.iterator || register === step.next,
			)
		)
			return undefined;
	}
	const flow = numberRecordDataflow(fn, shape.order, -1, representations, true);
	if (flow === undefined) return undefined;
	const inputs = new Set(flow.inputs);
	const targets = new Set<number>();
	for (const ip of shape.order)
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			if (!shape.members.has(successor)) targets.add(successor);
	const exits: Array<NativeNumericLoopRegionPlan["exits"][number]> = [];
	for (const targetIp of [...targets].sort((a, b) => a - b)) {
		if (targetIp >= fn.instructions.length) return undefined;
		const outputs = registersLiveAt(fn, body, targetIp, flow.written);
		const assigned = flow.assigned.get(targetIp) ?? new Set<number>();
		for (const register of outputs) {
			// The step leaves its value undefined once done, which a Number local cannot hold.
			if (register === step.valueDst || records.has(register)) return undefined;
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
			if (!assigned.has(register)) {
				if (numberRecordInputKind(representation) !== kind) return undefined;
				inputs.add(register);
			}
		}
		exits.push(Object.freeze({ targetIp, outputs: Object.freeze(outputs) }));
	}
	if ([...inputs].some((register) => records.has(register))) return undefined;
	const claimedIps = [...shape.members, shape.entryIp].sort((a, b) => a - b);
	return Object.freeze({
		kind: "array-iteration" as const,
		initializeIp: cursor.initializeIp,
		iterator: cursor.iterator,
		...(records.size === 0 ? {} : { records: [...records].sort((a, b) => a - b) }),
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

function lowerNumericLoopRegion(
	fn: BytecodeFunction,
	header: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	body: NativeBodyFacts,
	conflicts: (ip: number) => boolean,
	lengthLoads: ReadonlySet<number>,
	cursorSteps: ReadonlyMap<number, { initializeIp: number; iterator: number }>,
	codeUnitReads: ReadonlySet<number>,
	dataViewCalls: ReadonlyMap<number, NativeDataViewCall>,
): NativeNumericLoopRegionPlan | undefined {
	const first = fn.instructions[header];
	const cursor = first?.opcode === "ITERATOR_STEP" ? cursorSteps.get(header) : undefined;
	if (cursor !== undefined)
		return lowerArrayIterationRegion(
			fn,
			header,
			representations,
			body,
			conflicts,
			cursor,
		);
	// Fixed-storage headers are comparisons, a view's length load, or a checked element read.
	if (
		first === undefined ||
		(!integerLoopInstruction(first) &&
			!lengthLoads.has(header) &&
			first.opcode !== "LOAD_PROPERTY") ||
		conflicts(header)
	)
		return undefined;
	const shape = numericLoopShape(fn, body, header, true);
	if (shape === undefined || conflicts(shape.entryIp) || shape.order.some(conflicts))
		return undefined;
	const storage = fixedNumericLoopStorage(
		fn,
		shape,
		body,
		lengthLoads,
		codeUnitReads,
		dataViewCalls,
	);
	if (storage === undefined && !integerLoopInstruction(first)) return undefined;
	const bindings =
		storage === undefined ? numericLoopBindings(fn, shape, body) : new Set<number>();
	if (bindings === undefined) return undefined;
	if (
		(storage === undefined &&
			shape.order.some((ip) => {
				const op = fn.instructions[ip]!;
				return (
					!integerLoopInstruction(op) &&
					op.opcode !== "LOAD_GLOBAL" &&
					op.opcode !== "LOAD_CAPTURED" &&
					!(op.opcode === "THROW_IF_TDZ" && bindings.has(op.src))
				);
			})) ||
		(storage === undefined &&
			!shape.order.some((ip) => {
				const instruction = fn.instructions[ip]!;
				return (
					instruction.opcode === "BINARY" &&
					INTEGER_LOOP_PROFITABLE_OPERATORS.has(instruction.operator)
				);
			}))
	)
		return undefined;
	const flow = numberRecordDataflow(
		fn,
		shape.order,
		-1,
		representations,
		storage !== undefined,
		storage?.views.some((view) => view.text === true) === true
			? codeUnitReads
			: undefined,
		true,
		new Map(storage?.dataViewCalls?.map((call) => [call.ip, call])),
	);
	if (flow === undefined) return undefined;
	const inputs = new Set(flow.inputs);
	const targets = new Set<number>();
	for (const ip of shape.order)
		for (const successor of numberRecordSuccessors(fn.instructions[ip]!, ip))
			if (!shape.members.has(successor)) targets.add(successor);
	if (targets.size === 0) return undefined;
	const exits: Array<NativeNumericLoopRegionPlan["exits"][number]> = [];
	// An inner back edge polls by leaving at its header, since the iteration's stores
	// already happened and a restart would repeat them.
	for (const targetIp of [...targets, ...shape.inner.keys()].sort((a, b) => a - b)) {
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
	// A record is an iteration's borrowed element, never a Number to pass in or out.
	const records = new Set(storage?.records ?? []);
	if (
		[...inputs].some((register) => records.has(register)) ||
		exits.some((exit) => exit.outputs.some((register) => records.has(register)))
	)
		return undefined;
	// Field reads guard on shapes the original loop caches, and a restart finishes the
	// whole region there; an inner loop entered per iteration retries once they are warm.
	if (shape.inner.size > 0 && records.size > 0) return undefined;
	const claimedIps = [...shape.members, shape.entryIp].sort((a, b) => a - b);
	return Object.freeze({
		...(storage === undefined
			? { kind: "integer" as const }
			: { kind: "fixed-numeric" as const, ...storage }),
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
	if (fn.isDerivedConstructor) return undefined;
	// A base constructor initializes `this`; elsewhere an inlined construction
	// initializes the fresh receiver it creates. One plan admits a single receiver.
	const ownReceiver = fn.isClassConstructor;
	let createdReceiver = false;
	const thisAliases = new Set<number>();
	const stores: Array<{ ip: number; instruction: StaticPropertyStore }> = [];
	const pureIps = new Set<number>();
	let thisEscaped = false;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (ownReceiver && instruction.opcode === "LOAD_THIS") {
			thisAliases.add(instruction.dst);
			pureIps.add(ip);
			continue;
		}
		if (!ownReceiver && instruction.opcode === "CREATE_BASE_CONSTRUCT_RECEIVER") {
			if (createdReceiver) break;
			createdReceiver = true;
			thisAliases.add(instruction.dst);
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
	receiverObjectPossible: (ip: number) => boolean,
): ReadonlyArray<NativePairedArrayLoopPlan> {
	const plans: Array<NativePairedArrayLoopPlan> = [];
	for (const indexed of indexedLoops) {
		if (plans.some((plan) => plan.lengthLoadIp === indexed.lengthLoadIp)) continue;
		const primary = fn.instructions[indexed.elementLoadIp];
		if (
			primary?.opcode !== "LOAD_PROPERTY" ||
			!receiverObjectPossible(indexed.lengthLoadIp) ||
			!receiverObjectPossible(indexed.elementLoadIp) ||
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
				receiverObjectPossible(ip) &&
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
	) =>
		| { readonly id: number; readonly role: "start" | "finish" | "link" }
		| undefined = () => undefined,
	transparentJumpTargets: ReadonlySet<number> = new Set(),
	materializeUpdateOutputs = true,
	selectUpdates = true,
	body?: NativeBodyFacts,
	numberInputsPossible: (ip: number) => boolean = () => true,
	receiverObjectPossible: (ip: number) => boolean = () => true,
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
			: lowerPairedArrayLoops(
					fn,
					indexedLoops,
					jumpTargets,
					conflicts,
					receiverObjectPossible,
				);
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
					!numberInputsPossible(candidate) ||
					!receiverObjectPossible(candidate) ||
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
				!numberInputsPossible(candidate) ||
				!receiverObjectPossible(candidate) ||
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
		const regionBody = body ?? analyzeNativeBodyFacts(fn);
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
					!receiverObjectPossible(candidate) ||
					terminalFusion(candidate) !== undefined ||
					pairedArrayLoopActions.has(candidate) ||
					propertyNumericUpdateActions.has(candidate) ||
					propertyProjectionActions.has(candidate),
				regionBody,
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
						!receiverObjectPossible(candidate) ||
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
		arrayInitializations:
			selection.kind === "render" ? selection.plans.arrayInitializations : [],
		mapEntries: selection.kind === "render" ? selection.plans.mapEntries : [],
		objectEnumerationSnapshots:
			selection.kind === "render" ? selection.plans.objectEnumerationSnapshots : [],
		spanContinuations:
			selection.kind === "render" ? selection.plans.spanContinuations : [],
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
		numericLoopRegions:
			selection.kind === "render" ? selection.plans.numericLoopRegions : [],
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
	receiverObjectPossible: (ip: number) => boolean,
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
						!receiverObjectPossible(membershipIp) ||
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
			const initialize = fn.instructions[initializeIp],
				first = fn.instructions[firstStepIp],
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
				initialize?.opcode !== "GET_ITERATOR" ||
				!receiverObjectPossible(initializeIp) ||
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

function selectLiteralPropertyDefinitions(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	strings: ReadonlyArray<ReadonlyArray<number>>,
	groups: ReadonlyArray<ReadonlyArray<number>>,
): Array<NativeLiteralPropertyDefinitionPlan> {
	if (!native.body.instructions.some((op) => op.opcode === "CREATE_STRING")) return [];
	let literalAt: ReturnType<typeof createNativeStringLiteralQuery> | undefined;
	const plans: Array<NativeLiteralPropertyDefinitionPlan> = [];
	for (const [ip, op] of native.body.instructions.entries()) {
		if (op.opcode !== "DEFINE_PROPERTY" || body.projection?.unreachable.has(ip)) continue;
		const representation = native.registerRepresentations[op.key];
		if (
			representation === "number" ||
			representation === "int32" ||
			representation === "boolean"
		)
			continue;
		const prior = native.body.instructions[ip - 1];
		const index =
			prior?.opcode === "CREATE_STRING" &&
			prior.dst === op.key &&
			!body.jumpTargets.has(ip)
				? prior.stringIndex
				: (literalAt ??= createNativeStringLiteralQuery(native, body, {
						externalGroups: groups,
						literalFact: (index) => index,
					}))(ip, op.key);
		const units = index === undefined ? undefined : strings[index];
		if (index !== undefined && units !== undefined && !stringConstantIsArrayIndex(units))
			plans.push({ instructionIp: ip, stringIndex: index });
	}
	return plans;
}

export function analyzeNativeFastPaths(
	native: NativeFunctionPlan,
	entry?: NativeDirectEntryPlan,
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	body = analyzeNativeBodyFacts(native.body),
): {
	readonly plans: NativeFastPathPlans;
	readonly refineForControlFlow: (body: NativeBodyFacts) => NativeFastPathPlans;
} {
	const fn = native.body;
	const { handlerEntries, jumpTargets, branchSources } = body;
	const literalPropertyDefinitions: Array<NativeLiteralPropertyDefinitionPlan> = [];
	const mathCalls: Array<NativeMathCallPlan> = [];
	const numberPredicates: Array<NativeNumberPredicatePlan> = [];
	const stringTransforms: Array<NativeStringTransformPlan> = [];
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
			const masks = native.facts?.[ip]?.inputKindMasks;
			const exactNumber =
				masks !== undefined &&
				compilerBuiltinInputKindsAreValid(masks, op.arguments.length + 1) &&
				masks[1] === COMPILER_VALUE_KIND_NUMBER;
			const mode =
				input === undefined ||
				(input.kind !== "register" && input.kind !== "number") ||
				rep === "string" ||
				rep === "boolean" ||
				(masks !== undefined &&
					((masks[1] ?? COMPILER_VALUE_KIND_TOP) & COMPILER_VALUE_KIND_NUMBER) === 0)
					? "non-number"
					: rep === "int32" || native.facts?.[ip]?.inputIntegerRanges?.[1] !== undefined
						? "integer"
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
		const arity = nativeGuardedMathArity(builtin.operation, op.arguments.length);
		if (arity === undefined) continue;
		mathCalls.push({
			instructionIp: ip,
			operation: builtin.operation,
			arity,
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
	const blocked = new Set([
		...(entry?.fieldParameters?.loads.map((load) => load.instructionIp) ?? []),
		...nativeRecordCallIps(native),
	]);
	// A physically forward copy edge can still poll on a native or exceptional cycle.
	const pollingEdges = new Set(
		native.gc.safepoints.flatMap((point) =>
			point.kind === "loop-backedge" ? [point.instructionIp] : [],
		),
	);
	const unavailable = (ip: number) => blocked.has(ip) || pollingEdges.has(ip);
	const numberInputsPossible = (ip: number): boolean => {
		const op = fn.instructions[ip];
		if (op?.opcode !== "BINARY" && op?.opcode !== "UNARY") return true;
		if (op?.opcode === "UNARY" && (op.operator === "!" || op.operator === "typeof"))
			return true;
		const masks = native.facts?.[ip]?.inputKindMasks;
		return (
			masks === undefined ||
			masks.every((mask) => (mask & COMPILER_VALUE_KIND_NUMBER) !== 0)
		);
	};
	const receiverObjectPossible = (ip: number): boolean => {
		const op = fn.instructions[ip];
		let receiver: number;
		if (op?.opcode === "GET_ITERATOR") receiver = op.source;
		else if (op?.opcode === "BINARY" && op.operator === "in") receiver = op.right;
		else if (
			op?.opcode === "LOAD_PROPERTY_STATIC" ||
			op?.opcode === "STORE_PROPERTY_STATIC" ||
			op?.opcode === "LOAD_PROPERTY" ||
			op?.opcode === "STORE_PROPERTY"
		)
			receiver = op.object;
		else return true;
		return (
			((instructionInputKind(native.facts?.[ip], receiver) ?? COMPILER_VALUE_KIND_TOP) &
				COMPILER_VALUE_KIND_OBJECT) !==
			0
		);
	};
	for (const site of native.fieldCalls ?? [])
		for (let ip = site.allocationIp; ip <= site.callIp; ip++) blocked.add(ip);
	for (const site of native.literalSwitches ?? [])
		for (let ip = site.instructionIp; ip <= site.endIp; ip++) blocked.add(ip);
	const fusions = new Map<
		number,
		{
			readonly id: number;
			readonly finishIp: number;
			readonly role: "start" | "finish" | "link";
		}
	>();
	const mapEntryBlocked = new Set(blocked);
	const snapshotOverlayIps = new Set<number>();
	const snapshotBlocked = new Set(blocked);
	// Numeric loop regions keep indexed-length loop, Array cursor and charCodeAt chain code
	// as their fallback.
	const numericLoopBlocked = new Set(blocked);
	const cursorSteps = new Map<number, { initializeIp: number; iterator: number }>();
	// An Array view's length is an own data property, so any `.length` load can bound its loop.
	const lengthLoads = new Set<number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH") lengthLoads.add(ip);
		else if (op.opcode === "LOAD_PROPERTY_STATIC") {
			const units = stringConstants[op.stringIndex];
			if (units !== undefined && String.fromCharCode(...units) === "length")
				lengthLoads.add(ip);
		}
	}
	const indexedLoops: Array<NativeIndexedLoopElement> = [];
	for (const action of native.regionActions) {
		const region = native.specializations[action.regionIndex]!;
		if (region.kind !== "indexed-length-loop")
			for (const ip of region.claimedIps) snapshotBlocked.add(ip);
		if (region.kind !== "builtin-collection-call-chain")
			for (const ip of region.claimedIps) mapEntryBlocked.add(ip);
		if (region.kind !== "numeric-fusion") {
			blocked.add(action.ip);
			for (const ip of region.claimedIps) blocked.add(ip);
		}
		if (
			region.kind !== "numeric-fusion" &&
			region.kind !== "indexed-length-loop" &&
			region.kind !== "array-values-iterator-cursor" &&
			region.kind !== "iterator-result-virtualization" &&
			region.kind !== "string-char-code-at-chain"
		) {
			numericLoopBlocked.add(action.ip);
			for (const ip of region.claimedIps) numericLoopBlocked.add(ip);
		}
		if (
			region.kind === "array-values-iterator-cursor" &&
			region.stateSynchronization === "materialize-before-observation"
		)
			for (const stepIp of region.stepIps)
				cursorSteps.set(stepIp, {
					initializeIp: region.initializeIp,
					iterator: region.iterator,
				});
		switch (region.kind) {
			case "numeric-fusion": {
				const pair = region.pairs[action.primaryIndex!]!;
				if (
					native.instructions[pair.firstIp]?.kind !== "unsigned-arithmetic" &&
					native.instructions[pair.finishIp]?.kind !== "unsigned-arithmetic"
				) {
					if (action.role !== "start" && action.role !== "finish")
						throw new Error("Invalid numeric-fusion action");
					// A chain's interior finishes one pair and starts the next.
					fusions.set(
						action.ip,
						fusions.has(action.ip)
							? { id: pair.firstIp, finishIp: pair.finishIp, role: "link" }
							: { id: pair.firstIp, finishIp: pair.finishIp, role: action.role },
					);
				}
				break;
			}
			case "indexed-length-loop": {
				snapshotOverlayIps.add(action.ip);
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
	const claim = (ip: number) => {
		blocked.add(ip);
		numericLoopBlocked.add(ip);
	};
	const spanBlocked = new Set([...blocked, ...pollingEdges, ...fusions.keys()]);
	const enumerationBlocked = new Set([
		...[...blocked].filter((ip) => !snapshotOverlayIps.has(ip)),
		...snapshotBlocked,
		...pollingEdges,
	]);
	const spanContinuations = selectNativeSpanContinuations(
		native,
		body,
		stringConstants,
		(ip) => unavailable(ip) || fusions.has(ip),
	);
	for (const plan of spanContinuations) for (const ip of plan.claimedIps) claim(ip);
	const mapEntries = selectNativeMapEntries(
		native,
		body,
		(ip) => mapEntryBlocked.has(ip) || pollingEdges.has(ip),
	);
	for (const plan of mapEntries) for (const ip of plan.claimedIps) claim(ip);
	const arrayBlocked = new Set([...blocked, ...pollingEdges]);
	const arrayInitializations = selectNativeArrayInitializations(
		native,
		body,
		stringConstants,
		unavailable,
	);
	for (const plan of arrayInitializations) for (const ip of plan.claimedIps) claim(ip);
	const numberRecordRegions: Array<NativeNumberRecordRegionPlan> = [];
	const numericLoopRegions: Array<NativeNumericLoopRegionPlan> = [];
	const objectEnumerationSnapshots = selectNativeObjectEnumerationSnapshots(
		native,
		body,
		stringConstants,
		(ip) =>
			(blocked.has(ip) && !snapshotOverlayIps.has(ip)) ||
			snapshotBlocked.has(ip) ||
			pollingEdges.has(ip),
	);
	for (const plan of objectEnumerationSnapshots)
		for (const ip of plan.claimedIps) claim(ip);
	// Profiled sites observe each original instruction.
	if (
		native.mode === "direct" &&
		!fn.isGenerator &&
		!fn.isAsync &&
		fn.profileSiteIds === undefined
	) {
		const loops = bytecodeLoopInstructions(fn);
		for (const ip of body.staticPropertyLoadIps) {
			if (unavailable(ip)) continue;
			const plan = lowerNumberRecordRegion(
				fn,
				ip,
				native.registerRepresentations,
				body,
				(candidate) => {
					return (
						unavailable(candidate) ||
						!numberInputsPossible(candidate) ||
						!receiverObjectPossible(candidate) ||
						!nativePlanKeepsOrdinaryLowering(native.instructions[candidate])
					);
				},
				loops[ip] === 1,
			);
			if (plan === undefined) continue;
			const members = new Set(plan.claimedIps);
			// Fallback fusion temporaries cannot enter or leave the admitted record state.
			if (
				plan.claimedIps.some((ip) => {
					const fusion = fusions.get(ip);
					return (
						fusion !== undefined &&
						(!members.has(fusion.id) || !members.has(fusion.finishIp))
					);
				})
			)
				continue;
			numberRecordRegions.push(plan);
			// A loop region keeps a number-record region's code as its per-iteration fallback.
			for (const claimedIp of plan.claimedIps) blocked.add(claimedIp);
		}
		// Paired Array loops compare elements of any type, so numeric regions leave them alone.
		for (const plan of lowerPairedArrayLoops(
			fn,
			indexedLoops,
			jumpTargets,
			(ip) =>
				unavailable(ip) || !nativePlanKeepsOrdinaryLowering(native.instructions[ip]),
			receiverObjectPossible,
		))
			for (const ip of plan.claimedIps) numericLoopBlocked.add(ip);
		// World facts alone make these the builtin on any primitive string, so a region
		// reads their code units directly once its entry admits the string.
		const calleeWriters = new Map<number, Array<BytecodeInstruction>>();
		for (const op of fn.instructions)
			for (const register of vmInstructionWriteRegisters(op))
				calleeWriters.set(register, [...(calleeWriters.get(register) ?? []), op]);
		const codeUnitReads = new Set(
			fn.instructions.flatMap((call, ip) => {
				const plan = native.instructions[ip];
				return call.opcode === "CALL" &&
					plan?.kind === "call" &&
					plan.guardedBuiltinCall?.operation === "String.prototype.charCodeAt" &&
					plan.guardedBuiltinCall.guard.dependencies.every(
						(dependency) => dependency.kind === "world",
					) &&
					call.callee !== call.thisValue &&
					(calleeWriters.get(call.callee) ?? []).every(
						(writer) =>
							writer.opcode === "LOAD_PROPERTY_STATIC" &&
							writer.object === call.thisValue &&
							String.fromCharCode(...(stringConstants[writer.stringIndex] ?? [])) ===
								"charCodeAt",
					)
					? [ip]
					: [];
			}),
		);
		const dataViewCalls = numericLoopDataViewCalls(
			fn,
			body,
			stringConstants,
			(ip) => native.instructions[ip],
		);
		for (const header of [...body.jumpTargets].sort((a, b) => a - b)) {
			if (numericLoopBlocked.has(header)) continue;
			const plan = lowerNumericLoopRegion(
				fn,
				header,
				native.registerRepresentations,
				body,
				// Its back edge polls by returning the iteration to the original loop.
				(candidate) => {
					const kind = native.instructions[candidate]?.kind;
					return (
						numericLoopBlocked.has(candidate) ||
						!numberInputsPossible(candidate) ||
						// Operand kind proofs refine the double lowering; the region replaces it.
						(!nativePlanKeepsOrdinaryLowering(native.instructions[candidate]) &&
							kind !== "unsigned-arithmetic" &&
							!typedArrayElementPlan(kind) &&
							kind !== "contained-fixed-typed-array-length" &&
							!(
								kind === "call" &&
								(codeUnitReads.has(candidate) || dataViewCalls.has(candidate))
							) &&
							kind !== "primitive-string-length")
					);
				},
				lengthLoads,
				cursorSteps,
				codeUnitReads,
				dataViewCalls,
			);
			if (plan === undefined) continue;
			// Without a counter the trip count is unknown, and proven element accesses are
			// already cheaper than admitting a view for a few iterations.
			if (
				plan.kind === "fixed-numeric" &&
				plan.counter === undefined &&
				plan.claimedIps.some((ip) => typedArrayElementPlan(native.instructions[ip]?.kind))
			)
				continue;
			const members = new Set(plan.claimedIps);
			// A retained fallback fusion cannot carry its private intermediate across a region boundary.
			if (
				plan.claimedIps.some((ip) => {
					const fusion = fusions.get(ip);
					return (
						fusion !== undefined &&
						(!members.has(fusion.id) || !members.has(fusion.finishIp))
					);
				})
			)
				continue;
			numericLoopRegions.push(plan);
			for (const claimedIp of plan.claimedIps) claim(claimedIp);
		}
	}
	const selected = lowerNativeFastPaths(
		fn,
		native.registerRepresentations,
		jumpTargets,
		(ip) => unavailable(ip) || !nativePlanKeepsOrdinaryLowering(native.instructions[ip]),
		{ kind: "select" },
		indexedLoops,
		(ip) => fusions.get(ip),
		transparent,
		// Every other consumer reads its registers through bytecode operands.
		fn.profileSiteIds !== undefined,
		// Fusion can keep a preceding RHS in its private temporary rather than the semantic local.
		!native.specializations.some((region) => region.kind === "numeric-fusion"),
		body,
		numberInputsPossible,
		receiverObjectPossible,
	);
	const plans: NativeFastPathPlans = {
		literalPropertyDefinitions,
		mathCalls,
		numberPredicates,
		stringTransforms,
		arrayInitializations,
		mapEntries,
		objectEnumerationSnapshots,
		spanContinuations,
		...selectArrayWindows(
			native,
			new Set([
				...(entry?.fieldParameters?.loads.map((load) => load.instructionIp) ?? []),
				...nativeRecordCallIps(native),
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
					...numericLoopRegions,
					...arrayInitializations,
					...mapEntries,
					...objectEnumerationSnapshots,
					...spanContinuations,
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
			receiverObjectPossible,
		),
		propertyProjections: selected.propertyProjections,
		propertyNumericUpdates: selected.propertyNumericUpdates,
		propertyReadRegions: selected.propertyReadRegions,
		propertyReadPairs: selected.propertyReadPairs,
		numberRecordRegions,
		numericLoopRegions,
		pairedArrayLoops: selected.pairedArrayLoops,
		...(selected.constructorInitialization === undefined
			? {}
			: { constructorInitialization: selected.constructorInitialization }),
		...(selected.privateFieldReserve === undefined
			? {}
			: { privateFieldReserve: selected.privateFieldReserve }),
	};
	return {
		plans,
		refineForControlFlow(projected) {
			const windows = nativeFastPathWindows(plans, false);
			const literalPropertyDefinitions = selectLiteralPropertyDefinitions(
				native,
				projected,
				stringConstants,
				windows.map((window) => window.claimedIps),
			);
			if (projected.projection === undefined)
				return { ...plans, literalPropertyDefinitions };
			// Overlay consumers own storage but never introduce helper entry points.
			const reserved = new Set<number>();
			for (const window of windows) for (const ip of window.claimedIps) reserved.add(ip);
			const unavailable = new Set([...spanBlocked, ...reserved]);
			for (const plan of plans.objectEnumerationSnapshots)
				for (const ip of plan.claimedIps) unavailable.add(ip);
			for (const plan of plans.mapEntries)
				for (const ip of plan.claimedIps) unavailable.add(ip);
			for (const plan of plans.arrayInitializations)
				for (const ip of plan.claimedIps) unavailable.add(ip);
			const spanContinuations = selectNativeSpanContinuations(
				native,
				projected,
				stringConstants,
				(ip) => unavailable.has(ip),
			);
			const enumerationUnavailable = new Set([...enumerationBlocked, ...reserved]);
			for (const plan of spanContinuations)
				for (const ip of plan.claimedIps) enumerationUnavailable.add(ip);
			for (const plan of plans.mapEntries)
				for (const ip of plan.claimedIps) enumerationUnavailable.add(ip);
			for (const plan of plans.arrayInitializations)
				for (const ip of plan.claimedIps) enumerationUnavailable.add(ip);
			const objectEnumerationSnapshots = selectNativeObjectEnumerationSnapshots(
				native,
				projected,
				stringConstants,
				(ip) => enumerationUnavailable.has(ip),
			);
			const mapUnavailable = new Set([...mapEntryBlocked, ...pollingEdges, ...reserved]);
			for (const plan of [...spanContinuations, ...objectEnumerationSnapshots])
				for (const ip of plan.claimedIps) mapUnavailable.add(ip);
			for (const plan of plans.arrayInitializations)
				for (const ip of plan.claimedIps) mapUnavailable.add(ip);
			const unreachable = projected.projection.unreachable;
			const survives = (plan: { readonly claimedIps: ReadonlyArray<number> }) =>
				plan.claimedIps.some((ip) => !unreachable.has(ip));
			const liveSite = (plan: { readonly instructionIp: number }) =>
				!unreachable.has(plan.instructionIp);
			const mapEntries = selectNativeMapEntries(native, projected, (ip) =>
				mapUnavailable.has(ip),
			);
			const arrayInitializations = plans.arrayInitializations.filter(survives);
			if (arrayInitializations.length < ARRAY_INITIALIZATION_LIMITS.maximumCandidates) {
				const unavailable = new Set([...arrayBlocked, ...reserved]);
				for (const plan of [
					...spanContinuations,
					...objectEnumerationSnapshots,
					...mapEntries,
					...arrayInitializations,
				])
					for (const ip of plan.claimedIps) unavailable.add(ip);
				arrayInitializations.push(
					...selectNativeArrayInitializations(native, projected, stringConstants, (ip) =>
						unavailable.has(ip),
					).slice(
						0,
						ARRAY_INITIALIZATION_LIMITS.maximumCandidates - arrayInitializations.length,
					),
				);
				arrayInitializations.sort(
					(left, right) => left.allocationIp - right.allocationIp,
				);
			}
			const { constructorInitialization, privateFieldReserve, ...remaining } = plans;
			return {
				...remaining,
				literalPropertyDefinitions,
				mathCalls: plans.mathCalls.filter(liveSite),
				numberPredicates: plans.numberPredicates.filter(liveSite),
				stringTransforms: plans.stringTransforms.filter(liveSite),
				arrayInitializations,
				propertyNumericUpdates: plans.propertyNumericUpdates.filter(survives),
				propertyProjections: plans.propertyProjections.filter(survives),
				propertyReadRegions: plans.propertyReadRegions.filter(survives),
				propertyReadPairs: plans.propertyReadPairs.filter(survives),
				numberRecordRegions: plans.numberRecordRegions.filter(survives),
				numericLoopRegions: plans.numericLoopRegions.filter(survives),
				pairedArrayLoops: plans.pairedArrayLoops.filter(survives),
				arrayPresence: plans.arrayPresence.filter(survives),
				arrayPairDestructure: plans.arrayPairDestructure.filter(survives),
				...(constructorInitialization !== undefined && survives(constructorInitialization)
					? { constructorInitialization }
					: {}),
				...(privateFieldReserve !== undefined && survives(privateFieldReserve)
					? { privateFieldReserve }
					: {}),
				spanContinuations,
				objectEnumerationSnapshots,
				mapEntries,
			};
		},
	};
}

export function nativeFastPathWindows(
	fastPaths: NativeFastPathPlans,
	includeOverlays = true,
) {
	return [
		...fastPaths.propertyProjections,
		...fastPaths.propertyNumericUpdates,
		...fastPaths.propertyReadRegions,
		...fastPaths.propertyReadPairs,
		...fastPaths.numberRecordRegions,
		...fastPaths.numericLoopRegions,
		...(includeOverlays
			? [
					...fastPaths.arrayInitializations,
					...fastPaths.mapEntries,
					...fastPaths.objectEnumerationSnapshots,
					...fastPaths.spanContinuations,
				]
			: []),
		...fastPaths.pairedArrayLoops,
		...fastPaths.arrayPresence,
		...fastPaths.arrayPairDestructure,
		...(fastPaths.constructorInitialization === undefined
			? []
			: [fastPaths.constructorInitialization]),
		...(fastPaths.privateFieldReserve === undefined
			? []
			: [fastPaths.privateFieldReserve]),
	];
}
