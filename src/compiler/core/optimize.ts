import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { ConstructedCoreCompilation, CoreCompilation } from "./core-compilation.ts";
import { CORE_CONTROL_FLOW_PASSES } from "./core-control-flow-passes.ts";
import { runCoreCrossCallTransforms } from "./core-cross-call-transforms.ts";
import { CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS } from "./core-ir-provenance.ts";
import { CORE_FUNCTION_REACHABILITY_ANALYSIS } from "./core-ir-reachability.ts";
import { buildCoreOptimizationPlan } from "./core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "./core-ir-region-validity.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import {
	CORE_LOCAL_CANONICALIZATION_PASSES,
	CORE_LOCAL_FINALIZATION_PASSES,
} from "./core-local-passes.ts";
import { CORE_MEMORY_PASSES } from "./core-memory-passes.ts";
import { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import type {
	CoreInstrumentationMode,
	CoreOptimizationReport,
} from "./core-optimization-report.ts";
import { CorePassManager } from "./core-pass-manager.ts";
import type { CoreOptimizationStage } from "./core-pass.ts";
import { CORE_PROOF_PASSES } from "./core-proof-passes.ts";
import type { CoreTransformBudgetLimits } from "./core-transform-candidates.ts";

export type { CoreOptimizationPlan } from "./core-ir-regions.ts";

const OPTIMIZATION_STAGES: ReadonlyArray<CoreOptimizationStage> = [
	"canonicalize",
	"control-flow",
	"proofs",
	"memory",
	"finalize",
];

export interface OptimizeCoreOptions {
	readonly verification?: CoreVerificationProfile;
	readonly mode?: "development" | "full";
	readonly instrumentation?: CoreInstrumentationMode;
}

interface CoreOptimizerWorkProfile {
	readonly optionalMaxRunsPerWorkItem: number;
	readonly crossCallBudgets?: CoreTransformBudgetLimits;
	readonly specializationBudgets?: CoreTransformBudgetLimits;
}

const DEVELOPMENT_TRANSFORM_BUDGETS: CoreTransformBudgetLimits = Object.freeze({
	perSiteExpansions: 0,
	perCallerExpansions: 0,
	perCallerGeneratedCode: 32,
	perCallerCompilerWork: 128,
	programGeneratedCode: 256,
	programCompilerWork: 2_048,
});

const CORE_OPTIMIZER_WORK_PROFILES: Readonly<
	Record<"development" | "full", CoreOptimizerWorkProfile>
> = Object.freeze({
	development: Object.freeze({
		optionalMaxRunsPerWorkItem: 1,
		crossCallBudgets: DEVELOPMENT_TRANSFORM_BUDGETS,
		specializationBudgets: DEVELOPMENT_TRANSFORM_BUDGETS,
	}),
	full: Object.freeze({ optionalMaxRunsPerWorkItem: Number.MAX_SAFE_INTEGER }),
});

export interface OptimizedCoreResult {
	readonly compilation: CoreCompilation;
	readonly report: CoreOptimizationReport;
}

export function optimizeCore(
	compilation: ConstructedCoreCompilation,
	options: OptimizeCoreOptions = {},
): OptimizedCoreResult {
	const profile =
		CORE_OPTIMIZER_WORK_PROFILES[
			options.mode ?? compilation.context.facts.compilationMode
		];
	verifyCoreProgram(
		compilation.program,
		{ stage: "pre-optimization" },
		compilation.context,
	);
	const reportBuilder = new CoreOptimizationReportBuilder(
		compilation.program,
		options.instrumentation ?? "full",
	);
	const analyses = new CoreAnalysisManager(
		compilation.program,
		compilation.context,
		reportBuilder,
	);
	const passes = new CorePassManager(
		compilation.program,
		compilation.context,
		analyses,
		reportBuilder,
		{
			verification: options.verification,
			optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
		},
	);
	for (const stage of OPTIMIZATION_STAGES) {
		passes.runStage(
			stage,
			stage === "canonicalize"
				? CORE_LOCAL_CANONICALIZATION_PASSES
				: stage === "control-flow"
					? CORE_CONTROL_FLOW_PASSES
					: stage === "proofs"
						? CORE_PROOF_PASSES
						: stage === "memory"
							? CORE_MEMORY_PASSES
							: CORE_LOCAL_FINALIZATION_PASSES,
		);
	}
	const crossCallStartedAt = reportBuilder.collectsCounters ? Date.now() : 0;
	const crossCall = runCoreCrossCallTransforms(
		compilation.program,
		analyses,
		passes,
		profile.crossCallBudgets,
	);
	reportBuilder.recordTransformWork(crossCall.statistics);
	if (reportBuilder.collectsCounters) {
		reportBuilder.recordStage("interprocedural", Date.now() - crossCallStartedAt);
	}
	const programStartedAt = reportBuilder.collectsCounters ? Date.now() : 0;
	const summaries = crossCall.summaries;
	const reachability = analyses.get(CORE_FUNCTION_REACHABILITY_ANALYSIS, {
		scope: "program",
	});
	reportBuilder.recordProgramWork(
		summaries.targets.statistics,
		summaries.statistics,
		reachability.statistics,
	);
	if (reportBuilder.collectsCounters) {
		reportBuilder.recordStage("program", Date.now() - programStartedAt);
	}
	const planStartedAt = reportBuilder.collectsCounters ? Date.now() : 0;
	if (reportBuilder.collectsCounters) {
		reportBuilder.increment(
			"specializationFunctionsScanned",
			reachability.liveFunctions.length,
		);
	}
	for (const functionId of reachability.liveFunctions) {
		const discovery = analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, {
			scope: "function",
			function: functionId,
		});
		reportBuilder.recordCandidateDiscovery(discovery.candidates);
	}
	const plan = buildCoreOptimizationPlan(
		compilation.program,
		analyses,
		summaries,
		reachability.liveFunctions,
		{
			context: compilation.context,
			budgets: profile.specializationBudgets,
		},
	);
	const program = compilation.program.seal();
	const verifiedPlan = verifyCoreOptimizationPlan(program, plan);
	reportBuilder.recordPlanWork(verifiedPlan.statistics);
	if (reportBuilder.collectsCounters) {
		reportBuilder.recordStage("specialization", Date.now() - planStartedAt);
	}
	verifyCoreProgram(program, { stage: "pre-target" }, compilation.context);
	const optimized = Object.freeze({
		program,
		context: compilation.context,
		plan: verifiedPlan,
	});
	return Object.freeze({
		compilation: optimized,
		report: reportBuilder.finish(program, verifiedPlan),
	});
}
