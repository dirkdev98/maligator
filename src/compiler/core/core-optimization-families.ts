import type { CorePassBudget } from "./core-pass.ts";
import {
	CORE_SPECIALIZATION_EXPANSIONS_PER_FUNCTION,
	DEFAULT_CORE_SPECIALIZATION_BUDGETS,
	DEFAULT_CORE_TRANSFORM_BUDGETS,
} from "./core-transform-candidates.ts";

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

export const CORE_OPTIMIZATION_BENCHMARK_ABLATIONS = Object.freeze([
	...CORE_OPTIMIZATION_FAMILIES,
	"guarded-direct-call",
] as const);

export type CoreOptimizationFamily = (typeof CORE_OPTIMIZATION_FAMILIES)[number];
export type CoreAdvancedOptimizationFamily = Exclude<
	CoreOptimizationFamily,
	"o1-scalar-structural"
>;

export const CORE_O2_PASS_BUDGETS = Object.freeze({
	"cfg-loop-licm-pre": Object.freeze({
		maxWorkItems: 1_000_000,
		maxEdits: 500_000,
		exhaustion: "stop",
	}),
	"proof-value-kind-representation": Object.freeze({
		maxWorkItems: 2_000_000,
		maxEdits: 1_000_000,
		exhaustion: "stop",
	}),
	"provenance-escape-scalar-replacement": Object.freeze({
		maxWorkItems: 2_000_000,
		maxEdits: 1_000_000,
		exhaustion: "stop",
	}),
	"memory-ssa-load-store": Object.freeze({
		maxWorkItems: 2_000_000,
		maxEdits: 1_000_000,
		exhaustion: "stop",
	}),
}) satisfies Readonly<
	Record<
		Exclude<
			CoreAdvancedOptimizationFamily,
			"program-flow" | "inlining-cross-call" | "late-specialization-direct-entry"
		>,
		CorePassBudget
	>
>;

export interface CoreOptimizationProfitabilityContract {
	readonly admissionPredicate: string;
	readonly expectedBenefit: string;
	readonly compilerWorkEstimate: string;
	readonly generatedCodeEstimate: string;
	readonly perFunctionBudget: string;
	readonly wholeProgramBudget: string;
	readonly measurementLane: string;
}

export const CORE_OPTIMIZATION_PROFITABILITY_CONTRACTS = Object.freeze({
	"cfg-loop-licm-pre": Object.freeze({
		admissionPredicate: "a pass-specific CFG, loop, PRE, or hoist opportunity is present",
		expectedBenefit: "fewer executed branches, expressions, or loop-body operations",
		compilerWorkEstimate: "visited Core work items and edits reported per pass",
		generatedCodeEstimate: "net Core instruction and block delta",
		perFunctionBudget: "1,000,000 work items and 500,000 edits per admitted pass",
		wholeProgramBudget: "the per-function cap multiplied only by admitted live functions",
		measurementLane: "javascript:core",
	}),
	"proof-value-kind-representation": Object.freeze({
		admissionPredicate:
			"a concrete proof, value-kind, representation, or branch-fold consumer is present",
		expectedBenefit: "fewer guards, boxes, generic operations, or branches",
		compilerWorkEstimate: "visited Core work items and edits reported per pass",
		generatedCodeEstimate: "net Core instruction delta plus selected-region cost",
		perFunctionBudget: "2,000,000 work items and 1,000,000 edits per admitted pass",
		wholeProgramBudget: "the per-function cap multiplied only by admitted live functions",
		measurementLane: "javascript:core",
	}),
	"provenance-escape-scalar-replacement": Object.freeze({
		admissionPredicate:
			"an allocation, shape, property, or scalar-replacement consumer is present",
		expectedBenefit: "fewer heap allocations, property helpers, roots, and safepoints",
		compilerWorkEstimate: "visited Core work items and edits reported per pass",
		generatedCodeEstimate: "net Core delta plus materialization and fallback costs",
		perFunctionBudget: "2,000,000 work items and 1,000,000 edits per admitted pass",
		wholeProgramBudget: "the per-function cap multiplied only by admitted live functions",
		measurementLane: "javascript:allocation",
	}),
	"memory-ssa-load-store": Object.freeze({
		admissionPredicate:
			"a removable or forwardable access, scalar candidate, or loop-dependence consumer is present",
		expectedBenefit: "fewer memory reads, writes, property helpers, and repeated loads",
		compilerWorkEstimate: "visited Core work items and edits reported per pass",
		generatedCodeEstimate: "net Core instruction delta",
		perFunctionBudget: "2,000,000 work items and 1,000,000 edits per admitted pass",
		wholeProgramBudget: "the per-function cap multiplied only by admitted live functions",
		measurementLane: "javascript:objects",
	}),
	"program-flow": Object.freeze({
		admissionPredicate:
			"reachable calls, summaries, value kinds, or reachability consumers require a program solve",
		expectedBenefit:
			"enables dead-function removal and profitable cross-function specialization",
		compilerWorkEstimate: "functions, SCC nodes, edges, transfers, and caller wakeups",
		generatedCodeEstimate: "zero directly; consumers account for their emitted changes",
		perFunctionBudget: "one cached result per unchanged program and function version",
		wholeProgramBudget: "one initial solve plus at most two bounded cross-call re-solves",
		measurementLane: "self-compile:optimizeCore",
	}),
	"inlining-cross-call": Object.freeze({
		admissionPredicate:
			"a reachable single-target linear call can fit the cross-call family cap and shared O3 ledger",
		expectedBenefit: "fewer call dispatches and exposed local scalar optimization",
		compilerWorkEstimate:
			"target instructions, values, guards, and caller reoptimization",
		generatedCodeEstimate: "cloned target instructions plus guarded generic fallback",
		perFunctionBudget: `${DEFAULT_CORE_TRANSFORM_BUDGETS.perCallerExpansions} expansions, ${DEFAULT_CORE_TRANSFORM_BUDGETS.perCallerGeneratedCode} generated-code units, and ${DEFAULT_CORE_TRANSFORM_BUDGETS.perCallerCompilerWork} compiler-work units`,
		wholeProgramBudget: `${DEFAULT_CORE_TRANSFORM_BUDGETS.programGeneratedCode} generated-code units and ${DEFAULT_CORE_TRANSFORM_BUDGETS.programCompilerWork} compiler-work units within the shared O3 ledger`,
		measurementLane: "javascript:allocation",
	}),
	"late-specialization-direct-entry": Object.freeze({
		admissionPredicate:
			"a supported local region, guarded call, or direct entry can fit the remaining shared O3 ledger",
		expectedBenefit:
			"fewer generic helpers, allocations, boxes, guards, and call dispatches",
		compilerWorkEstimate: "generated-code cost model compile score",
		generatedCodeEstimate:
			"estimated C statements and binary bytes including generic fallback",
		perFunctionBudget: `${CORE_SPECIALIZATION_EXPANSIONS_PER_FUNCTION} expansive regions, ${DEFAULT_CORE_SPECIALIZATION_BUDGETS.perCallerGeneratedCode} generated-code units, and ${DEFAULT_CORE_SPECIALIZATION_BUDGETS.perCallerCompilerWork} compiler-work units`,
		wholeProgramBudget: `${DEFAULT_CORE_SPECIALIZATION_BUDGETS.programGeneratedCode} generated-code units and ${DEFAULT_CORE_SPECIALIZATION_BUDGETS.programCompilerWork} compiler-work units shared with cross-call transforms`,
		measurementLane: "http:express-routes",
	}),
}) satisfies Readonly<
	Record<CoreAdvancedOptimizationFamily, CoreOptimizationProfitabilityContract>
>;

export interface CoreOptimizationBenchmarkAblation {
	readonly family: (typeof CORE_OPTIMIZATION_BENCHMARK_ABLATIONS)[number];
}
