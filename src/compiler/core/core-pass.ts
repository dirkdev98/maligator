import type {
	CoreAnalysisDefinition,
	CoreAnalysisManager,
} from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreFunctionFeatureBits } from "./core-function-features.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type {
	CoreChangeDomain,
	CoreChangeSet,
	CoreFunctionStore,
	CoreProgram,
	CoreProgramChangeDomain,
} from "./core-store.ts";

export type CoreOptimizationStage =
	| "canonicalize"
	| "control-flow"
	| "proofs"
	| "memory"
	| "interprocedural"
	| "finalize";

export type CorePassWakeKind = CoreChangeDomain | CoreProgramChangeDomain;

export interface CoreFunctionPassWorkItem {
	readonly function: CoreFunctionId;
}

export interface CorePassBudget {
	readonly maxWorkItems: number;
	readonly maxEdits: number;
	readonly exhaustion: "stop" | "error";
}

export class CoreOptimizationBudgetError extends Error {}

export interface CorePassCapabilities {
	readonly cfg: boolean;
	readonly calls: boolean;
	readonly facts: boolean;
	readonly representations: boolean;
}

export interface CoreFunctionPassContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly item: CoreFunctionPassWorkItem;
	readonly remainingEdits: number;
	deferForBudget(): void;
	analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result;
	instructions(): Iterable<CoreInstructionId>;
}

export interface CoreFunctionPassAdmissionContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly function: CoreFunctionId;
}

export interface CoreFunctionPassAdmission {
	readonly predicate: string;
	hasOpportunity(context: CoreFunctionPassAdmissionContext): boolean;
}

export interface CoreFunctionPass {
	readonly name: string;
	readonly stage: CoreOptimizationStage;
	readonly requiredFunctionFeatures?: CoreFunctionFeatureBits;
	readonly requiredFunctionOpcodesAny?: ReadonlyArray<string>;
	readonly admission?: CoreFunctionPassAdmission;
	readonly candidates?: {
		readonly dependencies: ReadonlyArray<CoreChangeDomain>;
		readonly opcodes: ReadonlyArray<string>;
		matches?(
			fn: CoreFunctionStore,
			instruction: CoreInstructionId,
			opcode: string,
		): boolean;
	};
	readonly requiredAnalyses: ReadonlyArray<CoreAnalysisDefinition<unknown>>;
	readonly wakesOn: ReadonlyArray<CorePassWakeKind>;
	readonly changes: CorePassCapabilities;
	readonly budget: CorePassBudget;
	run(context: CoreFunctionPassContext): CoreChangeSet | undefined;
}

export class CoreFunctionPassContextDriver implements CoreFunctionPassContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly item: CoreFunctionPassWorkItem;
	readonly #analyses: CoreAnalysisManager;
	readonly #pass: CoreFunctionPass;
	#remainingEdits = 0;
	readonly #candidateIndex:
		| {
				readonly opcodes: Array<string | undefined>;
				function: CoreFunctionStore | undefined;
				readonly versions: Array<number>;
				instructions: Array<CoreInstructionId>;
		  }
		| undefined;

	constructor(
		program: CoreProgram,
		compilationContext: CoreCompilationContext,
		analyses: CoreAnalysisManager,
		pass: CoreFunctionPass,
		functionId: CoreFunctionId,
	) {
		this.program = program;
		this.compilationContext = compilationContext;
		this.#analyses = analyses;
		this.#pass = pass;
		this.item = Object.freeze({ function: functionId });
		if (pass.candidates !== undefined) {
			const opcodes: Array<string | undefined> = [];
			for (const opcode of pass.candidates.opcodes) {
				const descriptor = program.registry.get(opcode);
				if (descriptor !== undefined) opcodes[descriptor.id] = opcode;
			}
			this.#candidateIndex = {
				opcodes,
				function: undefined,
				versions: [],
				instructions: [],
			};
		}
	}

	get remainingEdits(): number {
		return this.#remainingEdits;
	}

	instructions(): Iterable<CoreInstructionId> {
		const fn = this.program.function(this.item.function);
		const selector = this.#pass.candidates;
		if (selector === undefined) return fn.instructionIds();
		const index = this.#candidateIndex!;
		let current = index.function === fn;
		for (
			let dependency = 0;
			current && dependency < selector.dependencies.length;
			dependency++
		) {
			current =
				index.versions[dependency] === fn.version(selector.dependencies[dependency]!);
		}
		if (!current) {
			index.instructions = [];
			for (const instruction of fn.instructionIds()) {
				const opcode = index.opcodes[fn.kernel.instructionOpcode(instruction)];
				if (
					opcode !== undefined &&
					(selector.matches === undefined || selector.matches(fn, instruction, opcode))
				)
					index.instructions.push(instruction);
			}
			index.function = fn;
			for (let dependency = 0; dependency < selector.dependencies.length; dependency++) {
				index.versions[dependency] = fn.version(selector.dependencies[dependency]!);
			}
		}
		return index.instructions;
	}

	hasCandidates(): boolean {
		if (this.#candidateIndex === undefined) return true;
		this.instructions();
		return this.#candidateIndex.instructions.length > 0;
	}

	prepare(remainingEdits: number): CoreFunctionPassContext {
		this.#remainingEdits = remainingEdits;
		return this;
	}

	deferForBudget(): void {
		if (this.#pass.budget.exhaustion === "error")
			throw new CoreOptimizationBudgetError(
				`Required Core pass ${this.#pass.name} exhausted its work budget`,
			);
	}

	analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result {
		if (definition.scope !== "function") {
			throw new Error(
				`Core function pass ${this.#pass.name} queried ${definition.scope}-scoped analysis ${definition.key}`,
			);
		}
		let declared = false;
		for (const allowed of this.#pass.requiredAnalyses) {
			if (allowed.key !== definition.key) continue;
			declared = true;
			break;
		}
		if (!declared) {
			throw new Error(
				`Core pass ${this.#pass.name} queried undeclared analysis ${definition.key}`,
			);
		}
		return this.#analyses.get(definition, {
			scope: "function",
			function: this.item.function,
		});
	}
}
