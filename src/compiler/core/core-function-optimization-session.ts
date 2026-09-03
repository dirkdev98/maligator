import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_CONTROL_FLOW_PASSES } from "./core-control-flow-passes.ts";
import type { CoreEditor } from "./core-editor.ts";
import { CoreFunctionFeatureIndex } from "./core-function-features.ts";
import {
	buildCoreLocalOptimizationPlanInput,
	coreLocalSpecializationFeatureIndex,
} from "./core-ir-region-selection.ts";
import type { CoreLocalOptimizationPlanInput } from "./core-ir-region-selection.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import { verifyCoreChangeSet } from "./core-ir-verifier.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import { CoreLocalOptimizer, CoreLocalRuleRegistry } from "./core-local-optimizer.ts";
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
	readonly crossCallWave?: number;
}

export interface CoreCrossCallFunctionOptimizationResult {
	readonly changes: CoreChangeSet | undefined;
	readonly localPlanInput: CoreLocalOptimizationPlanInput;
}

export class CoreFunctionOptimizationResources {
	readonly localRules: CoreLocalRuleRegistry;
	readonly featureIndex: CoreFunctionFeatureIndex;
	readonly specializationFeatureIndex: CoreFunctionFeatureIndex;
	readonly #primaryFunctions = new Set<CoreFunctionId>();
	readonly #crossCallFunctions = new Map<number, Set<CoreFunctionId>>();

	constructor(program: CoreProgram) {
		this.localRules = new CoreLocalRuleRegistry(program);
		this.featureIndex = new CoreFunctionFeatureIndex(program, this.localRules.dispatch);
		this.specializationFeatureIndex = coreLocalSpecializationFeatureIndex(program);
	}

	claimPrimary(functionId: CoreFunctionId): void {
		if (this.#primaryFunctions.has(functionId)) {
			throw new Error(`Core function ${functionId} already has a primary session`);
		}
		this.#primaryFunctions.add(functionId);
	}

	claimCrossCall(wave: number, functionId: CoreFunctionId): void {
		const functions = this.#crossCallFunctions.get(wave) ?? new Set();
		if (functions.has(functionId)) {
			throw new Error(
				`Core function ${functionId} already has a cross-call session in wave ${wave}`,
			);
		}
		functions.add(functionId);
		this.#crossCallFunctions.set(wave, functions);
	}
}

export class CoreFunctionOptimizationSession {
	readonly functionId: CoreFunctionId;
	readonly #program: CoreProgram;
	readonly #context: CoreCompilationContext;
	readonly #analyses: CoreAnalysisManager;
	readonly #passes: CorePassManager;
	readonly #specializationFeatureIndex: CoreFunctionFeatureIndex;
	readonly #localRules: CoreLocalRuleRegistry;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #verification: CoreVerificationProfile;
	readonly #crossCall: boolean;
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
		if (options.crossCallWave === undefined) resources.claimPrimary(functionId);
		else resources.claimCrossCall(options.crossCallWave, functionId);
		this.functionId = functionId;
		this.#program = program;
		this.#context = context;
		this.#analyses = new CoreAnalysisManager(program, context, report);
		this.#specializationFeatureIndex = resources.specializationFeatureIndex;
		this.#localRules = resources.localRules;
		this.#report = report;
		this.#verification = options.verification ?? "boundary";
		this.#crossCall = options.crossCallWave !== undefined;
		this.#passes = new CorePassManager(program, context, this.#analyses, report, {
			verification: options.verification,
			optionalMaxRunsPerWorkItem: options.optionalMaxRunsPerWorkItem,
			localOptimization: true,
			functionIds: [functionId],
			featureIndex: resources.featureIndex,
			localRules: resources.localRules,
		});
	}

	optimizePrimary(
		runPhase: CoreFunctionOptimizationPhaseRunner,
	): CoreLocalOptimizationPlanInput {
		if (this.#crossCall) {
			throw new Error(`Core function ${this.functionId} is a cross-call session`);
		}
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
		return runPhase("specialization-discovery", () =>
			buildCoreLocalOptimizationPlanInput(
				this.#program,
				this.#analyses,
				this.#specializationFeatureIndex,
				this.functionId,
				this.#context,
			),
		);
	}

	optimizeCrossCall(editor: CoreEditor): CoreCrossCallFunctionOptimizationResult {
		if (!this.#crossCall) {
			throw new Error(`Core function ${this.functionId} is a primary session`);
		}
		if (this.#optimized) {
			throw new Error(`Core function ${this.functionId} session already optimized`);
		}
		if (editor.program !== this.#program || editor.function.id !== this.functionId) {
			throw new Error("Cross-call editor belongs to another Core function");
		}
		this.#optimized = true;
		const result = new CoreLocalOptimizer(this.#program, this.functionId, {
			ruleRegistry: this.#localRules,
			editor,
		}).run();
		this.#report.recordLocalOptimizerWork(
			"cross-call-local-optimizer",
			result.statistics,
		);
		if (result.changes !== undefined && this.#verification === "per-pass") {
			verifyCoreChangeSet(this.#program, result.changes, {
				stage: "interprocedural",
				pass: "cross-call-local-optimizer",
				functionIndex: this.functionId,
			});
		}
		if (result.changes !== undefined && result.changes.edits > 0) {
			const initial = [result.changes];
			this.#passes.runStage(
				"control-flow",
				CORE_CONTROL_FLOW_PASSES,
				initial,
				"control-flow",
				false,
			);
			this.#passes.runStage("proofs", CORE_PROOF_PASSES, initial, "proofs", false);
			this.#passes.runStage("memory", CORE_MEMORY_PASSES, initial, "memory", false);
		}
		return Object.freeze({
			changes: result.changes,
			localPlanInput: buildCoreLocalOptimizationPlanInput(
				this.#program,
				this.#analyses,
				this.#specializationFeatureIndex,
				this.functionId,
				this.#context,
			),
		});
	}
}
