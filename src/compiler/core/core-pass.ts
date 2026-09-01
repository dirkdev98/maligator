import type {
	CoreAnalysisDefinition,
	CoreAnalysisManager,
	CoreAnalysisRequest,
} from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreBlockId, CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type {
	CoreChangeDomain,
	CoreChangeSet,
	CoreProgram,
	CoreProgramChangeDomain,
} from "./core-store.ts";

export type CorePassScope = "instruction" | "block" | "function" | "scc" | "program";

export type CoreOptimizationStage =
	| "canonicalize"
	| "control-flow"
	| "proofs"
	| "memory"
	| "interprocedural"
	| "finalize";

export type CorePassWakeKind = CoreChangeDomain | CoreProgramChangeDomain;

export type CorePassWorkItem =
	| {
			readonly scope: "instruction";
			readonly function: CoreFunctionId;
			readonly instruction: CoreInstructionId;
	  }
	| {
			readonly scope: "block";
			readonly function: CoreFunctionId;
			readonly block: CoreBlockId;
	  }
	| { readonly scope: "function"; readonly function: CoreFunctionId }
	| {
			readonly scope: "scc";
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
	readonly requiredAnalyses: ReadonlyArray<CoreAnalysisDefinition<unknown>>;
	readonly wakesOn: ReadonlyArray<CorePassWakeKind>;
	readonly preserves: ReadonlyArray<string>;
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

export function corePassContext(
	program: CoreProgram,
	compilationContext: CoreCompilationContext,
	analyses: CoreAnalysisManager,
	pass: CorePass,
	item: CorePassWorkItem,
	remainingEdits: number,
): CorePassContext {
	const allowed = new Set(pass.requiredAnalyses.map(({ key }) => key));
	return {
		program,
		compilationContext,
		item,
		remainingEdits,
		analysis<Result>(definition: CoreAnalysisDefinition<Result>): Result {
			if (!allowed.has(definition.key)) {
				throw new Error(
					`Core pass ${pass.name} queried undeclared analysis ${definition.key}`,
				);
			}
			return analyses.get(definition, coreAnalysisRequestForPass(definition, item));
		},
	};
}
