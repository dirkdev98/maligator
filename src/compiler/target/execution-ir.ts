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

/**
 * Backend-neutral executable semantics after SSA optimization and allocation.
 *
 * This boundary is deliberately richer than bytecode: it retains exact register
 * storage, safepoint provenance, simultaneous copies, and typed specialization
 * decisions. Bytecode and native planning consume it independently; neither
 * emitter is allowed to rediscover Core facts.
 */
export interface ExecutionProgram {
	readonly core: SealedCoreProgram;
	readonly context: CoreCompilationContext;
	readonly functionMap: ExecutionFunctionMap;
	readonly functions: ReadonlyArray<ExecutionFunction>;
}

/** Stable Core identities relocated to the dense function table used at runtime. */
export interface ExecutionFunctionMap {
	readonly coreToExecution: ReadonlyArray<number>;
	readonly executionToCore: ReadonlyArray<CoreFunctionId>;
}

export function executionFunctionIndex(map: ExecutionFunctionMap, core: number): number {
	if (!Number.isSafeInteger(core) || core < 0) {
		throw new Error(`Invalid Core function reference ${core}`);
	}
	const execution = map.coreToExecution[core];
	if (execution === undefined || execution < 0) {
		throw new Error(`Core function ${core} is not present in the execution plan`);
	}
	return execution;
}

export type ExecutionMove = Extract<CompilerInstruction, { type: "move" }>;

export type ExecutionRegisterRepresentation =
	| "boxed"
	| "int32"
	| "number"
	| "boolean"
	| "string";

/** A simultaneous assignment and its cycle-safe sequential realization. */
export interface ExecutionParallelCopy {
	readonly kind: "edge" | "handler-input";
	readonly assignments: ReadonlyArray<{
		readonly destination: number;
		readonly source: number;
	}>;
	readonly moves: ReadonlyArray<ExecutionMove>;
	readonly temporaries: ReadonlyArray<number>;
}

export type ExecutionSafepoint =
	| {
			readonly kind: "operation";
			/** Core instruction that emitted `instruction`. */
			readonly coreInstruction: CoreInstructionId;
			/** Core collection points realized while this operation executes. */
			readonly realizedCoreInstructions: ReadonlyArray<CoreInstructionId>;
			readonly instruction: CompilerInstruction;
			/** Exact boxed physical registers required by this collection point. */
			readonly rootRegisters: ReadonlyArray<number>;
	  }
	| {
			readonly kind: "loop-backedge";
			readonly instruction: CompilerInstruction;
			/** Exact boxed physical registers required by the taken-edge poll. */
			readonly rootRegisters: ReadonlyArray<number>;
	  };

/**
 * One ordinary-call entry contract selected from closed-world call-site facts.
 *
 * The canonical function entry remains boxed and is always the semantic fallback.
 * A direct entry is an additional native-only sibling: an exact callee guard may
 * transport proven scalar parameters and/or a proven scalar result without
 * changing the bytecode ABI or making open-world calls depend on speculation.
 */
export interface ExecutionDirectEntry {
	readonly id: number;
	readonly parameterRepresentations: ReadonlyArray<ExecutionRegisterRepresentation>;
	readonly resultRepresentation: ExecutionRegisterRepresentation;
	readonly fieldParameters?: {
		readonly keys: ReadonlyArray<number>;
		readonly loads: ReadonlyArray<{
			readonly instruction: CompilerInstruction;
			readonly field: number;
		}>;
	};
	readonly argumentRepresentations?: ReadonlyArray<ExecutionRegisterRepresentation>;
	readonly operatorInputs?: ReadonlyArray<{
		readonly instruction: CompilerInstruction;
		readonly masks: CompilerOperatorInputKindMasks;
	}>;
	readonly constantBooleans?: ReadonlyArray<{
		readonly instruction: CompilerInstruction;
		readonly value: boolean;
	}>;
	readonly registerRepresentations: ReadonlyArray<ExecutionRegisterRepresentation>;
	readonly gc: {
		readonly safepoints: ReadonlyArray<ExecutionSafepoint>;
	};
}

export interface ExecutionFunction {
	readonly sourcePath: string;
	readonly functionIndex: number;
	readonly nameStringIndex: number;
	readonly blocks: ReadonlyArray<{
		readonly instructions: ReadonlyArray<CompilerInstruction>;
	}>;
	readonly coreBlocks: ReadonlyArray<CoreBlockId>;
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
	readonly registerRepresentations: ReadonlyArray<ExecutionRegisterRepresentation>;
	/** Bounded native-only ordinary-call ABIs; bytecode continues to use boxed entry. */
	readonly directEntries: ReadonlyArray<ExecutionDirectEntry>;
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
	readonly hasPrototype: boolean;
	readonly gc: {
		/** Every operation collection point and native loop-backedge poll. */
		readonly safepoints: ReadonlyArray<ExecutionSafepoint>;
	};
	readonly parallelCopies: ReadonlyArray<ExecutionParallelCopy>;
	readonly temporaryRegisters: ReadonlyArray<number>;
}
