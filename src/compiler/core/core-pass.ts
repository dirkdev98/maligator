import type {
	CoreAnalysisDefinition,
	CoreAnalysisManager,
} from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreFunctionFeatureBits } from "./core-function-features.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import type {
	CoreChangeDomain,
	CoreChangeSet,
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
	analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result;
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
	}

	get remainingEdits(): number {
		return this.#remainingEdits;
	}

	prepare(remainingEdits: number): CoreFunctionPassContext {
		this.#remainingEdits = remainingEdits;
		return this;
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
