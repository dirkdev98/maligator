import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { ConstructedCoreCompilation, CoreCompilation } from "./core-compilation.ts";
import { runCoreCrossCallTransforms } from "./core-cross-call-transforms.ts";
import {
	CoreFunctionOptimizationResources,
	CoreFunctionOptimizationSession,
} from "./core-function-optimization-session.ts";
import type { CoreFunctionOptimizationPhaseRunner } from "./core-function-optimization-session.ts";
import { buildCoreOptimizationPlan } from "./core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "./core-ir-region-validity.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import {
	CORE_CONSTRUCTION_ANNOTATION_PASSES,
	CORE_CONSTRUCTION_NORMALIZATION_PASSES,
} from "./core-local-passes.ts";
import { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import type {
	CoreInstrumentationMode,
	CoreOptimizationPhase,
	CoreOptimizationReport,
} from "./core-optimization-report.ts";
import { CorePassManager } from "./core-pass-manager.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "./core-program-flow-analysis.ts";
import type { CoreTransformBudgetLimits } from "./core-transform-candidates.ts";

export type { CoreOptimizationPlan } from "./core-ir-regions.ts";

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
	const instrumentation = options.instrumentation ?? "off";
	const profile =
		CORE_OPTIMIZER_WORK_PROFILES[
			options.mode ?? compilation.context.facts.compilationMode
		];
	const reportBuilder = new CoreOptimizationReportBuilder(
		compilation.program,
		instrumentation,
	);
	const measurePhase = <Result>(
		phase: CoreOptimizationPhase,
		run: () => Result,
	): Result => {
		if (!reportBuilder.collectsPhases) return run();
		const startedAt = Date.now();
		try {
			return run();
		} finally {
			reportBuilder.recordPhase(phase, Date.now() - startedAt);
		}
	};
	reportBuilder.recordCheckpoint("after-core-construction", compilation.program);
	measurePhase("pre-optimization-verification", () =>
		verifyCoreProgram(
			compilation.program,
			{ stage: "pre-optimization" },
			compilation.context,
		),
	);
	if (reportBuilder.collectsCounters) {
		for (const functionId of compilation.program.functionIds()) {
			compilation.program.function(functionId).configureUseTraversalStatistics(true);
		}
	}
	measurePhase("construction-cleanup", () => undefined);
	{
		const analyses = new CoreAnalysisManager(
			compilation.program,
			compilation.context,
			reportBuilder,
		);
		const annotationPasses = new CorePassManager(
			compilation.program,
			compilation.context,
			analyses,
			reportBuilder,
			{
				verification: options.verification,
				optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
				localOptimization: false,
			},
		);
		measurePhase("initial-local-optimization", () =>
			annotationPasses.runStage("canonicalize", CORE_CONSTRUCTION_ANNOTATION_PASSES),
		);
		const normalizationPasses = new CorePassManager(
			compilation.program,
			compilation.context,
			analyses,
			reportBuilder,
			{
				verification: options.verification,
				optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
				localOptimization: true,
			},
		);
		measurePhase("structural-cfg-optimization", () =>
			normalizationPasses.runStage(
				"canonicalize",
				CORE_CONSTRUCTION_NORMALIZATION_PASSES,
			),
		);
	}
	reportBuilder.recordCheckpoint(
		"after-initial-local-structural-optimization",
		compilation.program,
	);
	measurePhase("dense-generation-barrier", () =>
		compilation.program.finalizeConstructionGeneration(),
	);
	reportBuilder.recordCheckpoint(
		"after-construction-generation-finalization",
		compilation.program,
	);
	if (reportBuilder.collectsCounters) {
		for (const functionId of compilation.program.functionIds()) {
			compilation.program.function(functionId).configureUseTraversalStatistics(true);
		}
	}
	const functionResources = new CoreFunctionOptimizationResources(compilation.program);
	const functionPhaseTimes = new Map<CoreOptimizationPhase, number>();
	const runFunctionPhase: CoreFunctionOptimizationPhaseRunner = (phase, run) => {
		if (!reportBuilder.collectsPhases) return run();
		const startedAt = Date.now();
		try {
			return run();
		} finally {
			functionPhaseTimes.set(
				phase,
				(functionPhaseTimes.get(phase) ?? 0) + Date.now() - startedAt,
			);
		}
	};
	for (const functionId of compilation.program.functionIds()) {
		new CoreFunctionOptimizationSession(
			compilation.program,
			compilation.context,
			reportBuilder,
			functionResources,
			functionId,
			{
				verification: options.verification,
				optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
			},
		).optimizePrimary(runFunctionPhase);
	}
	for (const phase of [
		"post-barrier-local-optimization",
		"advanced-cfg-optimization",
		"proof-and-representation-optimization",
		"memory-and-provenance-optimization",
		"late-local-cleanup",
	] as const) {
		reportBuilder.recordPhase(phase, functionPhaseTimes.get(phase) ?? 0);
	}
	reportBuilder.recordCheckpoint("before-memory-and-provenance", compilation.program);
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
			localOptimization: true,
			featureIndex: functionResources.featureIndex,
			localRules: functionResources.localRules,
		},
	);
	reportBuilder.recordCheckpoint("before-program-flow", compilation.program);
	const initialFlow = measurePhase("program-flow", () =>
		analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" }),
	);
	const crossCall = measurePhase("cross-call-transforms", () =>
		runCoreCrossCallTransforms(
			compilation.program,
			analyses,
			passes,
			profile.crossCallBudgets,
			initialFlow,
		),
	);
	reportBuilder.recordTransformWork(crossCall.statistics);
	reportBuilder.recordCheckpoint("after-cross-call-transforms", compilation.program);
	const summaries = crossCall.summaries;
	const reachability = analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, {
		scope: "program",
	}).reachability;
	reportBuilder.recordProgramWork(
		summaries.targets.statistics,
		summaries.statistics,
		reachability.statistics,
	);
	const plan = buildCoreOptimizationPlan(
		compilation.program,
		analyses,
		summaries,
		reachability.liveFunctions,
		{
			context: compilation.context,
			budgets: profile.specializationBudgets,
			...(reportBuilder.collectsPhases
				? {
						onPhase(phase: "discovery" | "selection", elapsedMs: number) {
							reportBuilder.recordPhase(
								phase === "discovery"
									? "specialization-discovery"
									: "specialization-selection",
								elapsedMs,
							);
						},
					}
				: {}),
			onLocalCandidates(_functionId, candidates) {
				reportBuilder.increment("specializationFunctionsScanned");
				reportBuilder.recordCandidateDiscovery(candidates);
			},
		},
	);
	reportBuilder.recordCheckpoint("before-sealing", compilation.program);
	const program = measurePhase("sealing", () => compilation.program.seal());
	reportBuilder.recordCheckpoint("after-sealing", program);
	const verifiedPlan = measurePhase("plan-verification", () =>
		verifyCoreOptimizationPlan(program, plan),
	);
	reportBuilder.recordPlanWork(verifiedPlan.statistics);
	measurePhase("final-core-verification", () =>
		verifyCoreProgram(program, { stage: "pre-target" }, compilation.context),
	);
	const optimized = Object.freeze({
		program,
		context: compilation.context,
		plan: verifiedPlan,
	});
	const report = reportBuilder.finish(program, verifiedPlan);
	if (reportBuilder.collectsCounters) {
		for (const functionId of compilation.program.functionIds()) {
			compilation.program.function(functionId).configureUseTraversalStatistics(false);
		}
	}
	return Object.freeze({
		compilation: optimized,
		report,
	});
}
