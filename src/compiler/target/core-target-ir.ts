import type { CoreCompilationContext } from "../core/core-compilation.ts";
import type { CoreAllocatedRegion } from "../core/core-ir-regions.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	SealedCoreProgram,
} from "../core/core-ir.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import type { CompilerOperatorInputKindMasks } from "../shared/compiler-value-kinds.ts";

export function targetInstructionUsesPropertyCache(
	instruction: CompilerInstruction,
): boolean {
	return (
		instruction.type === "loadProperty" ||
		instruction.type === "loadPropertyStatic" ||
		instruction.type === "loadPropertyStaticShapeCase" ||
		instruction.type === "storeProperty" ||
		instruction.type === "storePropertyStatic" ||
		instruction.type === "guardBaseConstructorLayout"
	);
}

/**
 * Shared operation semantics relocated into a backend-owned storage namespace.
 *
 * This boundary is deliberately richer than bytecode: it retains exact register
 * storage, safepoint provenance, simultaneous copies, and typed specialization
 * decisions. Each backend selects storage before consuming these operations; emitters
 * cannot rediscover Core proofs.
 */
export interface CoreTargetProgram {
	readonly core: SealedCoreProgram;
	readonly context: CoreCompilationContext;
	readonly functionMap: CoreTargetFunctionMap;
	readonly functions: ReadonlyArray<CoreTargetFunction>;
}

/** Stable Core identities relocated to the dense function table used at runtime. */
export interface CoreTargetFunctionMap {
	readonly coreToExecution: ReadonlyArray<number>;
	readonly executionToCore: ReadonlyArray<CoreFunctionId>;
}

export function coreTargetFunctionIndex(
	map: CoreTargetFunctionMap,
	core: number,
): number {
	if (!Number.isSafeInteger(core) || core < 0) {
		throw new Error(`Invalid Core function reference ${core}`);
	}
	const execution = map.coreToExecution[core];
	if (execution === undefined || execution < 0) {
		throw new Error(`Core function ${core} is not present in the execution plan`);
	}
	return execution;
}

export type CoreTargetMove = Extract<CompilerInstruction, { type: "move" }>;

export type CoreTargetRegisterRepresentation =
	| "boxed"
	| "int32"
	| "number"
	| "boolean"
	| "string";

export interface CoreTargetBlockOrderSpan {
	readonly first: number;
	readonly last: number;
}

/** A simultaneous assignment and its cycle-safe sequential realization. */
export interface CoreTargetParallelCopy {
	readonly kind: "edge" | "handler-input";
	readonly assignments: ReadonlyArray<{
		readonly destination: number;
		readonly source: number;
	}>;
	readonly moves: ReadonlyArray<CoreTargetMove>;
	readonly temporaries: ReadonlyArray<number>;
}

export interface CoreTargetSafepointRoots {
	/** Union retained by continuously rooted register storage. */
	readonly rootRegisters: ReadonlyArray<number>;
	/** Values needed before the operation runs, excluding output-only old values. */
	readonly incomingRootRegisters: ReadonlyArray<number>;
	/** Values needed after the operation, including outputs observed by a return poll. */
	readonly outgoingRootRegisters: ReadonlyArray<number>;
}

export type CoreTargetSafepoint = CoreTargetSafepointRoots &
	(
		| {
				readonly kind: "operation";
				/** Core instruction that emitted `instruction`. */
				readonly coreInstruction: CoreInstructionId;
				/** Core collection points realized while this operation executes. */
				readonly realizedCoreInstructions: ReadonlyArray<CoreInstructionId>;
				readonly instruction: CompilerInstruction;
		  }
		| {
				readonly kind: "loop-backedge";
				readonly instruction: CompilerInstruction;
		  }
	);

/**
 * One ordinary-call entry contract selected from closed-world call-site facts.
 *
 * The canonical function entry remains boxed and is always the semantic fallback.
 * A direct entry is an additional native-only sibling: an exact callee guard may
 * transport proven scalar parameters and/or a proven scalar result without
 * changing the bytecode ABI or making open-world calls depend on speculation.
 */
export interface CoreTargetDirectEntry {
	readonly id: number;
	readonly callOverrides?: ReadonlyArray<{
		readonly instruction: CompilerInstruction;
		readonly functionIndex: number;
		readonly entryId: number;
		readonly guarded?: true;
	}>;
	readonly parameterRepresentations: ReadonlyArray<CoreTargetRegisterRepresentation>;
	readonly resultRepresentation: CoreTargetRegisterRepresentation;
	readonly fieldParameters?: {
		readonly keys: ReadonlyArray<number>;
		readonly loads: ReadonlyArray<{
			readonly instruction: CompilerInstruction;
			readonly field: number;
		}>;
	};
	readonly argumentRepresentations?: ReadonlyArray<CoreTargetRegisterRepresentation>;
	readonly operatorInputs?: ReadonlyArray<{
		readonly instruction: CompilerInstruction;
		readonly masks: CompilerOperatorInputKindMasks;
	}>;
	readonly constantBooleans?: ReadonlyArray<{
		readonly instruction: CompilerInstruction;
		readonly value: boolean;
	}>;
	readonly registerRepresentations: ReadonlyArray<CoreTargetRegisterRepresentation>;
	readonly gc: {
		readonly safepoints: ReadonlyArray<CoreTargetSafepoint>;
	};
}

export interface CoreTargetFunction {
	readonly storageValues?: ReadonlyArray<number>;
	readonly specializedOnly?: true;
	readonly sourcePath: string;
	readonly functionIndex: number;
	readonly nameStringIndex: number;
	readonly blocks: ReadonlyArray<{
		readonly instructions: ReadonlyArray<CompilerInstruction>;
		/** Resets carried source attribution when native layout moves a block. */
		readonly sourcePosition?: number;
	}>;
	readonly coreBlocks: ReadonlyArray<CoreBlockId>;
	readonly propertyCacheOrigins: ReadonlyArray<{
		readonly instruction: CompilerInstruction;
		readonly coreInstruction: CoreInstructionId;
	}>;
	/** Typed Core decisions, already relocated to allocated registers and blocks. */
	readonly specializations: ReadonlyArray<CoreAllocatedRegion>;
	readonly isGenerator: boolean;
	readonly isAsync: boolean;
	readonly parameterCount: number;
	readonly mappedArgumentSlots: ReadonlyArray<number>;
	readonly mappedArguments: boolean;
	readonly length: number;
	readonly registerCount: number;
	/** First register introduced by execution lowering rather than Core allocation. */
	readonly allocatedRegisterCount: number;
	readonly registerRepresentations: ReadonlyArray<CoreTargetRegisterRepresentation>;
	/** Bounded native-only ordinary-call ABIs; bytecode continues to use boxed entry. */
	readonly directEntries: ReadonlyArray<CoreTargetDirectEntry>;
	readonly literalSwitches?: ReadonlyArray<
		{
			readonly first: CompilerInstruction;
			readonly last: CompilerInstruction;
			readonly selector: number;
			readonly defaultBlock: number;
		} & (
			| {
					readonly kind: "number";
					readonly cases: ReadonlyArray<{
						readonly value: number;
						readonly block: number;
					}>;
			  }
			| {
					readonly kind: "string";
					readonly cases: ReadonlyArray<{
						readonly stringIndex: number;
						readonly block: number;
					}>;
			  }
		)
	>;
	readonly fieldCalls?: ReadonlyArray<{
		readonly allocation: CompilerInstruction;
		readonly call: CompilerInstruction;
		readonly entries: ReadonlyArray<{
			readonly functionIndex: number;
			readonly entryId: number;
		}>;
	}>;
	readonly capturedCount: number;
	readonly strict: boolean;
	readonly isClassConstructor: boolean;
	readonly isDerivedConstructor: boolean;
	readonly constructorSlotReserve: number;
	readonly hasPrototype: boolean;
	readonly gc: {
		/** Every operation collection point and native loop-backedge poll. */
		readonly safepoints: ReadonlyArray<CoreTargetSafepoint>;
	};
	readonly parallelCopies: ReadonlyArray<CoreTargetParallelCopy>;
	readonly temporaryRegisters: ReadonlyArray<number>;
}
