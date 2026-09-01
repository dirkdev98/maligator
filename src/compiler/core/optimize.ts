import type {
	ConstructedCoreCompilation,
	CoreCompilation,
} from "./core-compilation.ts";
import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_CONTROL_FLOW_PASSES } from "./core-control-flow-passes.ts";
import { runCoreCrossCallTransforms } from "./core-cross-call-transforms.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import { CORE_LOCAL_CANONICALIZATION_PASSES } from "./core-local-passes.ts";
import { CORE_MEMORY_PASSES } from "./core-memory-passes.ts";
import { CORE_PROOF_PASSES } from "./core-proof-passes.ts";
import { CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS } from "./core-ir-provenance.ts";
import { analyzeCoreFunctionReachability } from "./core-ir-reachability.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import {
	CoreOptimizationReportBuilder,
} from "./core-optimization-report.ts";
import type { CoreOptimizationReport } from "./core-optimization-report.ts";
import { CorePassManager } from "./core-pass-manager.ts";
import type { CoreOptimizationStage } from "./core-pass.ts";

export interface CoreOptimizationPlan {
	readonly liveFunctions?: ReadonlyArray<CoreFunctionId>;
	readonly directEntries: ReadonlyArray<never>;
	readonly specializations: ReadonlyArray<never>;
}

const OPTIMIZATION_STAGES: ReadonlyArray<CoreOptimizationStage> = [
	"canonicalize",
	"control-flow",
	"proofs",
	"memory",
	"finalize",
];

export interface OptimizeCoreOptions {
	readonly verification?: CoreVerificationProfile;
}

export interface OptimizedCoreResult {
	readonly compilation: CoreCompilation;
	readonly report: CoreOptimizationReport;
}

export function optimizeCore(
	compilation: ConstructedCoreCompilation,
	options: OptimizeCoreOptions = {},
): OptimizedCoreResult {
	verifyCoreProgram(
		compilation.program,
		{ stage: "pre-optimization" },
		compilation.context,
	);
	const reportBuilder = new CoreOptimizationReportBuilder(compilation.program);
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
		{ verification: options.verification },
	);
	for (const stage of OPTIMIZATION_STAGES) {
		if (stage === "memory") {
			for (const functionId of compilation.program.functionIds()) {
				const discovery = analyses.get(CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS, {
					scope: "function",
					function: functionId,
				});
				reportBuilder.recordCandidateDiscovery(discovery.candidates);
			}
		}
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
							: [],
		);
	}
	const crossCallStartedAt = Date.now();
	const crossCall = runCoreCrossCallTransforms(
		compilation.program,
		analyses,
		passes,
	);
	reportBuilder.recordTransformWork(crossCall.statistics);
	reportBuilder.recordStage("interprocedural", Date.now() - crossCallStartedAt);
	const programStartedAt = Date.now();
	const summaries = crossCall.summaries;
	const reachability = analyzeCoreFunctionReachability(
		compilation.program,
		summaries.targets,
		compilation.context,
	);
	const plan: CoreOptimizationPlan = Object.freeze({
		liveFunctions: reachability.liveFunctions,
		directEntries: Object.freeze([]),
		specializations: Object.freeze([]),
	});
	reportBuilder.recordProgramWork(
		summaries.targets.statistics,
		summaries.statistics,
		reachability.statistics,
	);
	reportBuilder.recordStage("program", Date.now() - programStartedAt);
	const program = compilation.program.seal();
	verifyCoreProgram(program, { stage: "pre-target" }, compilation.context);
	const optimized = Object.freeze({
		program,
		context: compilation.context,
		plan,
	});
	return Object.freeze({
		compilation: optimized,
		report: reportBuilder.finish(program, plan),
	});
}
