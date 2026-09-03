import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_CONTROL_FLOW_PASSES } from "./core-control-flow-passes.ts";
import { CoreFunctionFeatureIndex } from "./core-function-features.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import { CoreLocalRuleRegistry } from "./core-local-optimizer.ts";
import {
	CORE_LATE_CANONICALIZATION_PASSES,
	CORE_LOCAL_CANONICALIZATION_PASSES,
} from "./core-local-passes.ts";
import { CORE_MEMORY_PASSES } from "./core-memory-passes.ts";
import type {
	CoreOptimizationPhase,
	CoreOptimizationReportBuilder,
} from "./core-optimization-report.ts";
import { CorePassManager } from "./core-pass-manager.ts";
import { CORE_PROOF_PASSES } from "./core-proof-passes.ts";
import type { CoreChangeSet, CoreProgram } from "./core-store.ts";

export type CoreFunctionOptimizationPhaseRunner = <Result>(
	phase: CoreOptimizationPhase,
	run: () => Result,
) => Result;

export interface CoreFunctionOptimizationSessionOptions {
	readonly verification?: CoreVerificationProfile;
	readonly optionalMaxRunsPerWorkItem?: number;
}

export class CoreFunctionOptimizationResources {
	readonly localRules: CoreLocalRuleRegistry;
	readonly featureIndex: CoreFunctionFeatureIndex;
	readonly #primaryFunctions = new Set<CoreFunctionId>();

	constructor(program: CoreProgram) {
		this.localRules = new CoreLocalRuleRegistry(program);
		this.featureIndex = new CoreFunctionFeatureIndex(program, this.localRules.dispatch);
	}

	claimPrimary(functionId: CoreFunctionId): void {
		if (this.#primaryFunctions.has(functionId)) {
			throw new Error(`Core function ${functionId} already has a primary session`);
		}
		this.#primaryFunctions.add(functionId);
	}
}

export class CoreFunctionOptimizationSession {
	readonly functionId: CoreFunctionId;
	readonly #passes: CorePassManager;
	#optimized = false;

	constructor(
		program: CoreProgram,
		context: CoreCompilationContext,
		report: CoreOptimizationReportBuilder,
		resources: CoreFunctionOptimizationResources,
		functionId: CoreFunctionId,
		options: CoreFunctionOptimizationSessionOptions = {},
	) {
		program.function(functionId);
		resources.claimPrimary(functionId);
		this.functionId = functionId;
		const analyses = new CoreAnalysisManager(program, context, report);
		this.#passes = new CorePassManager(program, context, analyses, report, {
			verification: options.verification,
			optionalMaxRunsPerWorkItem: options.optionalMaxRunsPerWorkItem,
			localOptimization: true,
			functionIds: [functionId],
			featureIndex: resources.featureIndex,
			localRules: resources.localRules,
		});
	}

	optimizePrimary(runPhase: CoreFunctionOptimizationPhaseRunner): void {
		if (this.#optimized) {
			throw new Error(`Core function ${this.functionId} session already optimized`);
		}
		this.#optimized = true;
		runPhase("post-barrier-local-optimization", () =>
			this.#passes.runStage("canonicalize", CORE_LOCAL_CANONICALIZATION_PASSES),
		);
		runPhase("advanced-cfg-optimization", () =>
			this.#passes.runStage("control-flow", CORE_CONTROL_FLOW_PASSES),
		);
		const lateCanonicalizationChanges: Array<CoreChangeSet> = [];
		lateCanonicalizationChanges.push(
			...runPhase("proof-and-representation-optimization", () =>
				this.#passes.runStage("proofs", CORE_PROOF_PASSES),
			),
		);
		lateCanonicalizationChanges.push(
			...runPhase("memory-and-provenance-optimization", () =>
				this.#passes.runStage("memory", CORE_MEMORY_PASSES),
			),
		);
		runPhase("late-local-cleanup", () => {
			if (lateCanonicalizationChanges.length === 0) return;
			this.#passes.runStage(
				"canonicalize",
				CORE_LATE_CANONICALIZATION_PASSES,
				lateCanonicalizationChanges,
				"finalize",
				false,
			);
		});
	}
}
