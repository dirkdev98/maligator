import type {
	CoreAnalysisDefinition,
	CoreAnalysisManager,
	CoreAnalysisRequest,
} from "./core-analysis-manager.ts";
import type { CoreFunctionFeatureBits } from "./core-function-features.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import type {
	CoreChangeDomain,
	CoreChangeSet,
	CoreProgram,
	CoreProgramChangeDomain,
} from "./core-store.ts";

export type CorePassScope = "function" | "scc" | "program";

export type CoreOptimizationStage =
	| "canonicalize"
	| "control-flow"
	| "proofs"
	| "memory"
	| "interprocedural"
	| "finalize";

export type CorePassWakeKind = CoreChangeDomain | CoreProgramChangeDomain;

export type CorePassWorkItem =
	| { readonly scope: "function"; readonly function: CoreFunctionId }
	| {
			readonly scope: "scc";
			readonly index: number;
			readonly id: string;
			readonly functions: ReadonlyArray<CoreFunctionId>;
	  }
	| { readonly scope: "program" };

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

export interface CorePassContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly item: CorePassWorkItem;
	readonly remainingEdits: number;
	analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result;
}

export interface CorePass {
	readonly name: string;
	readonly stage: CoreOptimizationStage;
	readonly scope: CorePassScope;
	readonly requiredFunctionFeatures?: CoreFunctionFeatureBits;
	readonly requiredAnalyses: ReadonlyArray<CoreAnalysisDefinition<unknown>>;
	readonly wakesOn: ReadonlyArray<CorePassWakeKind>;
	readonly changes: CorePassCapabilities;
	readonly budget: CorePassBudget;
	run(context: CorePassContext): CoreChangeSet | undefined;
}

export function coreAnalysisRequestForPass(
	definition: CoreAnalysisDefinition<unknown>,
	item: CorePassWorkItem,
): CoreAnalysisRequest {
	if (definition.scope === "program") return { scope: "program" };
	if (definition.scope === "scc") {
		if (item.scope !== "scc") {
			throw new Error(`Analysis ${definition.key} requires an SCC-scoped pass work item`);
		}
		return { scope: "scc", id: item.id, functions: item.functions };
	}
	if (item.scope === "program" || item.scope === "scc") {
		throw new Error(
			`Analysis ${definition.key} requires a function-scoped pass work item`,
		);
	}
	return { scope: "function", function: item.function };
}

export class CorePassContextDriver implements CorePassContext {
	readonly program: CoreProgram;
	readonly compilationContext: CoreCompilationContext;
	readonly #analyses: CoreAnalysisManager;
	readonly #pass: CorePass;
	#item: CorePassWorkItem | undefined;
	#remainingEdits = 0;

	constructor(
		program: CoreProgram,
		compilationContext: CoreCompilationContext,
		analyses: CoreAnalysisManager,
		pass: CorePass,
	) {
		this.program = program;
		this.compilationContext = compilationContext;
		this.#analyses = analyses;
		this.#pass = pass;
	}

	get item(): CorePassWorkItem {
		if (this.#item === undefined) throw new Error("Core pass context has no work item");
		return this.#item;
	}

	get remainingEdits(): number {
		return this.#remainingEdits;
	}

	prepare(item: CorePassWorkItem, remainingEdits: number): CorePassContext {
		this.#item = item;
		this.#remainingEdits = remainingEdits;
		return this;
	}

	analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result {
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
		return this.#analyses.get(
			definition,
			coreAnalysisRequestForPass(definition, this.item),
		);
	}
}
