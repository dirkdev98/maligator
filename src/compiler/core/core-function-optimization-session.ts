import { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CoreAnalysisScratchPool } from "./core-analysis-scratch.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CONTROL_FLOW_PASSES,
	CORE_LATE_REPRESENTATION_PASSES,
} from "./core-control-flow-passes.ts";
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
	CORE_MANDATORY_CANONICALIZATION_PASSES,
} from "./core-local-passes.ts";
import {
	CORE_MEMORY_PASSES,
	CORE_MEMORY_SSA_PASSES,
	CORE_PROVENANCE_PASSES,
} from "./core-memory-passes.ts";
import type { CoreOptimizationFamily } from "./core-optimization-families.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type {
	CoreOptimizationPhase,
	CoreOptimizationReportBuilder,
} from "./core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "./core-pass-manager.ts";
import { CORE_PROOF_PASSES, CORE_LATE_PROOF_PASSES } from "./core-proof-passes.ts";
import type { CoreChangeSet, CoreProgram } from "./core-store.ts";

export type CoreFunctionOptimizationPhaseRunner = <Result>(
	phase: CoreOptimizationPhase,
	run: () => Result,
) => Result;

export interface CoreFunctionOptimizationSessionOptions {
	readonly verification?: CoreVerificationProfile;
	readonly optionalMaxRunsPerWorkItem?: number;
	readonly crossCallWave?: number;
	readonly benchmarkAblation?: CoreOptimizationFamily;
}

export interface CoreCrossCallFunctionOptimizationResult {
	readonly changes: CoreChangeSet | undefined;
	readonly localPlanInput: CoreLocalOptimizationPlanInput;
}

export class CoreFunctionOptimizationResources {
	readonly localRules: CoreLocalRuleRegistry;
	readonly mandatoryLocalRules: CoreLocalRuleRegistry;
	readonly featureIndex: CoreFunctionFeatureIndex;
	readonly mandatoryFeatureIndex: CoreFunctionFeatureIndex;
	readonly specializationFeatureIndex: CoreFunctionFeatureIndex;
	readonly scratch: CoreAnalysisScratchPool;
	readonly #primaryFunctions = new Set<CoreFunctionId>();
	readonly #crossCallFunctions = new Map<number, Set<CoreFunctionId>>();

	constructor(program: CoreProgram) {
		this.localRules = new CoreLocalRuleRegistry(program);
		this.mandatoryLocalRules = new CoreLocalRuleRegistry(
			program,
			[],
			"mandatory-cleanup",
		);
		this.featureIndex = new CoreFunctionFeatureIndex(program, this.localRules.dispatch);
		this.mandatoryFeatureIndex = new CoreFunctionFeatureIndex(
			program,
			this.mandatoryLocalRules.dispatch,
		);
		this.specializationFeatureIndex = coreLocalSpecializationFeatureIndex(program);
		this.scratch = new CoreAnalysisScratchPool();
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
	readonly #passes: CoreFunctionPassScheduler;
	readonly #specializationFeatureIndex: CoreFunctionFeatureIndex;
	readonly #localRules: CoreLocalRuleRegistry;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #verification: CoreVerificationProfile;
	readonly #crossCall: boolean;
	readonly #benchmarkAblation: CoreOptimizationFamily | undefined;
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
		this.#analyses = new CoreAnalysisManager(program, context, report, resources.scratch);
		this.#specializationFeatureIndex = resources.specializationFeatureIndex;
		this.#benchmarkAblation = options.benchmarkAblation;
		const ablateLocalOptimization = this.#ablates("o1-scalar-structural");
		this.#localRules = ablateLocalOptimization
			? resources.mandatoryLocalRules
			: resources.localRules;
		this.#report = report;
		this.#verification = options.verification ?? "boundary";
		this.#crossCall = options.crossCallWave !== undefined;
		this.#passes = new CoreFunctionPassScheduler(
			program,
			context,
			this.#analyses,
			report,
			functionId,
			{
				verification: options.verification,
				optionalMaxRunsPerWorkItem: options.optionalMaxRunsPerWorkItem,
				localOptimization: true,
				localOptimizationReportName: ablateLocalOptimization
					? "mandatory-local-cleanup"
					: undefined,
				featureIndex: ablateLocalOptimization
					? resources.mandatoryFeatureIndex
					: resources.featureIndex,
				localRules: this.#localRules,
			},
		);
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
			this.#ablates("o1-scalar-structural")
				? this.#passes.runComponent(
						"canonicalize",
						CORE_MANDATORY_CANONICALIZATION_PASSES,
					)
				: this.#passes.runComponent("canonicalize", CORE_LOCAL_CANONICALIZATION_PASSES),
		);
		runPhase("advanced-cfg-optimization", () =>
			this.#ablates("cfg-loop-licm-pre")
				? []
				: this.#passes.runComponent("control-flow", CORE_CONTROL_FLOW_PASSES),
		);
		const lateCanonicalizationChanges: Array<CoreChangeSet> = [];
		lateCanonicalizationChanges.push(
			...runPhase("proof-and-representation-optimization", () =>
				this.#ablates("proof-value-kind-representation")
					? []
					: this.#passes.runComponent("proofs", CORE_PROOF_PASSES),
			),
		);
		const memoryPasses = CORE_MEMORY_PASSES.filter(
			(pass) =>
				(!this.#ablates("provenance-escape-scalar-replacement") ||
					!CORE_PROVENANCE_PASSES.includes(pass)) &&
				(!this.#ablates("memory-ssa-load-store") ||
					!CORE_MEMORY_SSA_PASSES.includes(pass)),
		);
		const memoryChanges = runPhase("memory-and-provenance-optimization", () =>
			memoryPasses.length === 0 ? [] : this.#passes.runComponent("memory", memoryPasses),
		);
		lateCanonicalizationChanges.push(...memoryChanges);
		runPhase("late-local-cleanup", () => {
			if (lateCanonicalizationChanges.length === 0) return;
			if (!this.#ablates("cfg-loop-licm-pre")) {
				lateCanonicalizationChanges.push(
					...this.#passes.runComponent(
						"control-flow",
						CORE_LATE_REPRESENTATION_PASSES,
						lateCanonicalizationChanges,
						{ seedLocalFromInitialChanges: false },
					),
				);
			}
			if (memoryChanges.length > 0 && !this.#ablates("proof-value-kind-representation")) {
				lateCanonicalizationChanges.push(
					...this.#passes.runComponent("proofs", CORE_LATE_PROOF_PASSES, memoryChanges, {
						seedLocalFromInitialChanges: false,
					}),
				);
			}
			this.#passes.runComponent(
				"canonicalize",
				CORE_LATE_CANONICALIZATION_PASSES,
				lateCanonicalizationChanges,
				{ seedLocalFromInitialChanges: false },
			);
		});
		return runPhase("specialization-discovery", () =>
			this.#report.measureOwner(CORE_OPTIMIZATION_OWNER.specializationDiscovery, () =>
				buildCoreLocalOptimizationPlanInput(
					this.#program,
					this.#analyses,
					this.#specializationFeatureIndex,
					this.functionId,
					this.#context,
					!this.#ablates("late-specialization-direct-entry"),
				),
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
		const result = this.#report.measureOwner(
			CORE_OPTIMIZATION_OWNER.fusedLocalOptimization,
			() =>
				new CoreLocalOptimizer(this.#program, this.functionId, {
					ruleRegistry: this.#localRules,
					editor,
				}).run(),
		);
		this.#report.recordOwnerWork(
			CORE_OPTIMIZATION_OWNER.fusedLocalOptimization,
			result.statistics.rulesConsidered,
		);
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
			this.#passes.runComponent("control-flow", CORE_CONTROL_FLOW_PASSES, initial, {
				seedLocalFromInitialChanges: false,
			});
			this.#passes.runComponent("proofs", CORE_PROOF_PASSES, initial, {
				seedLocalFromInitialChanges: false,
			});
			const memoryChanges = this.#passes.runComponent(
				"memory",
				CORE_MEMORY_PASSES,
				initial,
				{ seedLocalFromInitialChanges: false },
			);
			const representationChanges = this.#passes.runComponent(
				"control-flow",
				CORE_LATE_REPRESENTATION_PASSES,
				memoryChanges,
				{ seedLocalFromInitialChanges: false },
			);
			const proofChanges =
				memoryChanges.length === 0
					? []
					: this.#passes.runComponent("proofs", CORE_LATE_PROOF_PASSES, memoryChanges, {
							seedLocalFromInitialChanges: false,
						});
			this.#passes.runComponent(
				"canonicalize",
				CORE_LATE_CANONICALIZATION_PASSES,
				[...memoryChanges, ...representationChanges, ...proofChanges],
				{ seedLocalFromInitialChanges: false },
			);
		}
		return Object.freeze({
			changes: result.changes,
			localPlanInput: buildCoreLocalOptimizationPlanInput(
				this.#program,
				this.#analyses,
				this.#specializationFeatureIndex,
				this.functionId,
				this.#context,
				!this.#ablates("late-specialization-direct-entry"),
			),
		});
	}

	#ablates(family: CoreOptimizationFamily): boolean {
		return this.#benchmarkAblation === family;
	}
}
