export const CORE_OPTIMIZATION_FAMILIES = Object.freeze([
	"o1-scalar-structural",
	"cfg-loop-licm-pre",
	"proof-value-kind-representation",
	"provenance-escape-scalar-replacement",
	"memory-ssa-load-store",
	"program-flow",
	"inlining-cross-call",
	"late-specialization-direct-entry",
] as const);

export type CoreOptimizationFamily = (typeof CORE_OPTIMIZATION_FAMILIES)[number];

export interface CoreOptimizationBenchmarkAblation {
	readonly family: CoreOptimizationFamily;
}
