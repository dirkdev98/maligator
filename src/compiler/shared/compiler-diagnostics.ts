import type { SourceSiteId, UnknownFactReason } from "./compiler-facts.ts";

export type CompilerDiagnosticCode =
	| "primordial.mutation"
	| `optimization.applied.${string}`
	| `optimization.declined.${UnknownFactReason}`;

export type OptimizationDecisionReason =
	| "inner-closure"
	| "exception-region"
	| "relocation"
	| "expansion-limit"
	| "generated-code-cost"
	| "unavailable-world-fact"
	| "unsupported-consumer"
	| UnknownFactReason;

export interface CompilerOptimizationDecision {
	readonly functionIndex: number;
	readonly positionId: number;
	readonly operation: "call" | "allocation" | "property" | "boxing";
	readonly phase: "analysis" | "optimization" | "lowering";
	readonly code:
		| `optimization.applied.${string}`
		| `optimization.declined.${OptimizationDecisionReason}`;
	readonly outcome: "applied" | "declined";
	readonly reason?: OptimizationDecisionReason;
}

export const OPTIMIZATION_ABLATIONS = [
	"constant-folding",
	"escape",
	"inlining",
	"interprocedural",
	"static-properties",
] as const;

export type OptimizationAblation = (typeof OPTIMIZATION_ABLATIONS)[number];

export interface OptimizationMetrics {
	readonly instructions: number;
	readonly blocks: number;
	readonly values: number;
	readonly facts: number;
	readonly regions: number;
	readonly allocationSites: number;
	readonly dynamicCalls: number;
	readonly boxedOperations: number;
	readonly propertyHelpers: number;
	readonly worldGuards: number;
	/** Boxed Core SSA values that must remain rooted across collection points. */
	readonly rootedValues: number;
	readonly safepoints: number;
}

export interface OptimizationPassDelta {
	readonly pass: string;
	readonly stage: "normalization" | "fixpoint" | "finalization";
	readonly round?: number;
	readonly status:
		| "executed"
		| "feature-gated"
		| "ablated"
		| "region-blocked"
		| "partially-region-blocked";
	/** Functions skipped because a control-flow pass cannot mutate a selected region. */
	readonly regionBlockedFunctions?: number;
	readonly changed: boolean;
	readonly before: OptimizationMetrics;
	readonly after: OptimizationMetrics;
	readonly delta: OptimizationMetrics;
	readonly ablation?: OptimizationAblation;
}

export interface CompilerDiagnostic {
	readonly code: CompilerDiagnosticCode;
	readonly severity: "warning" | "remark";
	readonly message: string;
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly siteId: SourceSiteId;
}

export function compareCompilerDiagnostics(
	left: CompilerDiagnostic,
	right: CompilerDiagnostic,
): number {
	return (
		left.path.localeCompare(right.path) ||
		left.line - right.line ||
		left.column - right.column ||
		left.code.localeCompare(right.code)
	);
}
