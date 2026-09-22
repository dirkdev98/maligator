import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { ConstructedCoreCompilation, CoreCompilation } from "./core-compilation.ts";
import {
	emptyCoreCrossCallTransformResult,
	runCoreCrossCallTransforms,
} from "./core-cross-call-transforms.ts";
import {
	CoreFunctionOptimizationResources,
	CoreFunctionOptimizationSession,
} from "./core-function-optimization-session.ts";
import type { CoreFunctionOptimizationPhaseRunner } from "./core-function-optimization-session.ts";
import { buildCoreOptimizationPlan } from "./core-ir-region-selection.ts";
import type { CoreLocalOptimizationPlanInput } from "./core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "./core-ir-region-validity.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import {
	CORE_CONSTRUCTION_ANNOTATION_PASSES,
	CORE_CONSTRUCTION_NORMALIZATION_PASSES,
} from "./core-local-passes.ts";
import type { CoreOptimizationBenchmarkAblation } from "./core-optimization-families.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreOptimizationOwnerId } from "./core-optimization-owners.ts";
import { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import type {
	CoreInstrumentationMode,
	CoreOptimizationPhase,
	CoreOptimizationReport,
} from "./core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "./core-pass-manager.ts";
import {
	specializeCorePlatformConstants,
	pruneUnusedPlatformAliases,
} from "./core-platform-constants.ts";
import { pruneUnusedPlatformModuleInitializers } from "./core-platform-modules.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "./core-program-flow-analysis.ts";
import {
	CORE_SPECIALIZATION_EXPANSIONS_PER_FUNCTION,
	coreProgramTransformBudgets,
	CoreTransformCandidateService,
	DEFAULT_CORE_SPECIALIZATION_BUDGETS,
	DEFAULT_CORE_TRANSFORM_BUDGETS,
} from "./core-transform-candidates.ts";
import type { CoreTransformBudgetLimits } from "./core-transform-candidates.ts";

export type { CoreOptimizationPlan } from "./core-ir-regions.ts";

export interface OptimizeCoreOptions {
	readonly verification?: CoreVerificationProfile;
	readonly mode?: "development" | "full";
	readonly instrumentation?: CoreInstrumentationMode;
	readonly benchmarkAblation?: CoreOptimizationBenchmarkAblation;
}

interface CoreOptimizerWorkProfile {
	readonly optionalMaxRunsPerWorkItem: number;
	readonly o3Budgets?: CoreTransformBudgetLimits;
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
		o3Budgets: DEVELOPMENT_TRANSFORM_BUDGETS,
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
	specializeCorePlatformConstants(compilation);
	const instrumentation = options.instrumentation ?? "off";
	const ablatedFamily = options.benchmarkAblation?.family;
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
		owner?: CoreOptimizationOwnerId,
	): Result => {
		const runOwned =
			owner === undefined ? run : () => reportBuilder.measureOwner(owner, run);
		if (!reportBuilder.collectsPhases) return runOwned();
		const startedAt = Date.now();
		try {
			return runOwned();
		} finally {
			reportBuilder.recordPhase(phase, Date.now() - startedAt);
		}
	};
	reportBuilder.recordCheckpoint("after-core-construction", compilation.program);
	measurePhase(
		"pre-optimization-verification",
		() =>
			verifyCoreProgram(
				compilation.program,
				{ stage: "pre-optimization" },
				compilation.context,
			),
		CORE_OPTIMIZATION_OWNER.coreVerification,
	);
	reportBuilder.recordOwnerWork(
		CORE_OPTIMIZATION_OWNER.coreVerification,
		compilation.program.functionCapacity,
	);
	if (reportBuilder.collectsCounters) {
		for (const functionId of compilation.program.functionIds()) {
			compilation.program.function(functionId).configureUseTraversalStatistics(true);
		}
	}
	measurePhase("construction-cleanup", () => undefined);
	reportBuilder.measureOwner(
		CORE_OPTIMIZATION_OWNER.constructionStructuralCleanup,
		() => {
			const resources = new CoreFunctionOptimizationResources(compilation.program);
			const ablateLocalOptimization = ablatedFamily === "o1-scalar-structural";
			const phaseTimes = new Map<CoreOptimizationPhase, number>();
			const runFunctionPhase: CoreFunctionOptimizationPhaseRunner = (phase, run) => {
				if (!reportBuilder.collectsPhases) return run();
				const startedAt = Date.now();
				try {
					return run();
				} finally {
					phaseTimes.set(phase, (phaseTimes.get(phase) ?? 0) + Date.now() - startedAt);
				}
			};
			for (const functionId of compilation.program.functionIds()) {
				const analyses = new CoreAnalysisManager(
					compilation.program,
					compilation.context,
					reportBuilder,
					resources.scratch,
				);
				const annotationPasses = new CoreFunctionPassScheduler(
					compilation.program,
					compilation.context,
					analyses,
					reportBuilder,
					functionId,
					{
						verification: options.verification,
						optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
						featureIndex: resources.featureIndex,
					},
				);
				runFunctionPhase("initial-local-optimization", () =>
					annotationPasses.runComponent(
						"canonicalize",
						CORE_CONSTRUCTION_ANNOTATION_PASSES,
					),
				);
				const normalizationPasses = new CoreFunctionPassScheduler(
					compilation.program,
					compilation.context,
					analyses,
					reportBuilder,
					functionId,
					{
						verification: options.verification,
						optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
						localOptimization: true,
						localOptimizationReportName: ablateLocalOptimization
							? "mandatory-local-cleanup"
							: undefined,
						featureIndex: ablateLocalOptimization
							? resources.mandatoryFeatureIndex
							: resources.featureIndex,
						localRules: ablateLocalOptimization
							? resources.mandatoryLocalRules
							: resources.localRules,
					},
				);
				runFunctionPhase("structural-cfg-optimization", () =>
					normalizationPasses.runComponent(
						"canonicalize",
						CORE_CONSTRUCTION_NORMALIZATION_PASSES,
					),
				);
			}
			for (const phase of [
				"initial-local-optimization",
				"structural-cfg-optimization",
			] as const) {
				reportBuilder.recordPhase(phase, phaseTimes.get(phase) ?? 0);
			}
		},
	);
	reportBuilder.recordOwnerWork(
		CORE_OPTIMIZATION_OWNER.constructionStructuralCleanup,
		compilation.program.functionCapacity,
	);
	reportBuilder.recordCheckpoint(
		"after-initial-local-structural-optimization",
		compilation.program,
	);
	pruneUnusedPlatformAliases(compilation);
	pruneUnusedPlatformModuleInitializers(compilation);
	measurePhase(
		"dense-generation-barrier",
		() => compilation.program.finalizeConstructionGeneration(),
		CORE_OPTIMIZATION_OWNER.denseGenerationBarrier,
	);
	reportBuilder.recordOwnerWork(
		CORE_OPTIMIZATION_OWNER.denseGenerationBarrier,
		compilation.program.functionCapacity,
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
	const localPlanInputs: Array<CoreLocalOptimizationPlanInput> = [];
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
		localPlanInputs.push(
			new CoreFunctionOptimizationSession(
				compilation.program,
				compilation.context,
				reportBuilder,
				functionResources,
				functionId,
				{
					verification: options.verification,
					optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
					benchmarkAblation: ablatedFamily,
				},
			).optimizePrimary(runFunctionPhase),
		);
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
		functionResources.scratch,
	);
	reportBuilder.recordCheckpoint("before-program-flow", compilation.program);
	const initialFlow = measurePhase("program-flow", () =>
		analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" }),
	);
	const liveInstructions = initialFlow.reachability.liveFunctions.reduce(
		(total, functionId) =>
			total + compilation.program.function(functionId).liveStorageCounts().instructions,
		0,
	);
	const o3Candidates = new CoreTransformCandidateService(
		profile.o3Budgets ??
			coreProgramTransformBudgets(DEFAULT_CORE_SPECIALIZATION_BUDGETS, liveInstructions),
	);
	const crossCallBudgets =
		profile.o3Budgets ??
		coreProgramTransformBudgets(DEFAULT_CORE_TRANSFORM_BUDGETS, liveInstructions);
	const crossCall = measurePhase(
		"cross-call-transforms",
		() =>
			ablatedFamily === "inlining-cross-call"
				? emptyCoreCrossCallTransformResult(initialFlow)
				: runCoreCrossCallTransforms(
						compilation.program,
						analyses,
						(wave, functionId, editor) =>
							new CoreFunctionOptimizationSession(
								compilation.program,
								compilation.context,
								reportBuilder,
								functionResources,
								functionId,
								{
									verification: options.verification,
									optionalMaxRunsPerWorkItem: profile.optionalMaxRunsPerWorkItem,
									crossCallWave: wave,
									benchmarkAblation: ablatedFamily,
								},
							).optimizeCrossCall(editor),
						crossCallBudgets,
						initialFlow,
						o3Candidates,
					),
		CORE_OPTIMIZATION_OWNER.crossCallTransforms,
	);
	reportBuilder.recordTransformWork(crossCall.statistics);
	reportBuilder.recordOwnerWork(
		CORE_OPTIMIZATION_OWNER.crossCallTransforms,
		crossCall.statistics.considered,
	);
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
	const finalLocalPlanInputs = new Map(
		localPlanInputs.map((input) => [input.function, input] as const),
	);
	for (const input of crossCall.localPlanInputs) {
		finalLocalPlanInputs.set(input.function, input);
	}
	const plan = buildCoreOptimizationPlan(
		compilation.program,
		analyses,
		summaries,
		ablatedFamily === "program-flow"
			? [...compilation.program.functionIds()]
			: reachability.liveFunctions,
		{
			context: compilation.context,
			candidateService: o3Candidates,
			perFunctionExpansions: CORE_SPECIALIZATION_EXPANSIONS_PER_FUNCTION,
			localInputs: [...finalLocalPlanInputs.values()],
			discoverCandidates: ablatedFamily !== "late-specialization-direct-entry",
			...(reportBuilder.collectsPhases
				? {
						onPhase(phase: "discovery" | "selection", elapsedMs: number) {
							reportBuilder.recordOwnerElapsed(
								phase === "discovery"
									? CORE_OPTIMIZATION_OWNER.specializationDiscovery
									: CORE_OPTIMIZATION_OWNER.specializationSelection,
								elapsedMs,
							);
							reportBuilder.recordPhase(
								phase === "discovery"
									? "specialization-discovery"
									: "specialization-selection",
								phase === "discovery"
									? elapsedMs + (functionPhaseTimes.get("specialization-discovery") ?? 0)
									: elapsedMs,
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
	const verifiedPlan = measurePhase(
		"plan-verification",
		() => verifyCoreOptimizationPlan(program, plan, compilation.context),
		CORE_OPTIMIZATION_OWNER.coreVerification,
	);
	reportBuilder.recordPlanWork(verifiedPlan.statistics);
	reportBuilder.recordOwnerWork(
		CORE_OPTIMIZATION_OWNER.specializationDiscovery,
		verifiedPlan.statistics.considered,
	);
	reportBuilder.recordOwnerWork(
		CORE_OPTIMIZATION_OWNER.specializationSelection,
		verifiedPlan.statistics.applied + verifiedPlan.statistics.declined,
	);
	measurePhase(
		"final-core-verification",
		() => verifyCoreProgram(program, { stage: "pre-target" }, compilation.context),
		CORE_OPTIMIZATION_OWNER.coreVerification,
	);
	reportBuilder.recordOwnerWork(
		CORE_OPTIMIZATION_OWNER.coreVerification,
		program.functionCapacity,
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
