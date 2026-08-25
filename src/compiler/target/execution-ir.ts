import type { CoreCompilationContext } from "../core/core-compilation.ts";
import type { CoreAllocatedRegion } from "../core/core-ir-regions.ts";
import type { CoreInstructionId, CoreProgram } from "../core/core-ir.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";

/**
 * Backend-neutral executable semantics after SSA optimization and allocation.
 *
 * This boundary is deliberately richer than bytecode: it retains exact register
 * storage, safepoint provenance, simultaneous copies, and typed specialization
 * decisions. Bytecode and native planning consume it independently; neither
 * emitter is allowed to rediscover Core facts.
 */
export interface ExecutionProgram {
	readonly core: CoreProgram;
	readonly context: CoreCompilationContext;
	readonly functions: ReadonlyArray<ExecutionFunction>;
}

export type ExecutionMove = Extract<CompilerInstruction, { type: "move" }>;

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

export interface ExecutionFunction {
	readonly sourcePath: string;
	readonly functionIndex: number;
	readonly nameStringIndex: number;
	readonly blocks: ReadonlyArray<{
		readonly instructions: ReadonlyArray<CompilerInstruction>;
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
	readonly registerRepresentations: ReadonlyArray<"boxed" | "number" | "boolean">;
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
