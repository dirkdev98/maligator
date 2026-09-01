import type {
	ConstructedCoreCompilation,
	CoreCompilation,
} from "./core-compilation.ts";
import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_CONTROL_FLOW_PASSES } from "./core-control-flow-passes.ts";
import { verifyCoreProgram } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import { CORE_LOCAL_CANONICALIZATION_PASSES } from "./core-local-passes.ts";
import { CORE_MEMORY_PASSES } from "./core-memory-passes.ts";
import { CORE_PROOF_PASSES } from "./core-proof-passes.ts";
import { CORE_LOCAL_SPECIALIZATION_CANDIDATES_ANALYSIS } from "./core-ir-provenance.ts";
import {
	CoreOptimizationReportBuilder,
} from "./core-optimization-report.ts";
import type { CoreOptimizationReport } from "./core-optimization-report.ts";
import { CorePassManager } from "./core-pass-manager.ts";
import type { CoreOptimizationStage } from "./core-pass.ts";

export interface CoreOptimizationPlan {
	readonly directEntries: ReadonlyArray<never>;
	readonly specializations: ReadonlyArray<never>;
}

const EMPTY_OPTIMIZATION_PLAN: CoreOptimizationPlan = Object.freeze({
	directEntries: Object.freeze([]),
	specializations: Object.freeze([]),
});

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
	const program = compilation.program.seal();
	verifyCoreProgram(program, { stage: "pre-target" }, compilation.context);
	const optimized = Object.freeze({
		program,
		context: compilation.context,
		plan: EMPTY_OPTIMIZATION_PLAN,
	});
	return Object.freeze({
		compilation: optimized,
		report: reportBuilder.finish(program, EMPTY_OPTIMIZATION_PLAN),
	});
}
