import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_FUNCTION_HAS_BRANCHES,
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
	CORE_FUNCTION_FEATURE_MASK,
	CoreFunctionFeatureIndex,
} from "./core-function-features.ts";
import { verifyCoreChangeSet } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import type { CoreFunctionId, CoreOpcodeId } from "./core-ir.ts";
import { CoreLocalOptimizer, CoreLocalRuleRegistry } from "./core-local-optimizer.ts";
import type { CoreLocalOptimizerOptions } from "./core-local-optimizer.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreOptimizationOwnerId } from "./core-optimization-owners.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import {
	CoreFunctionPassContextDriver,
	CoreOptimizationBudgetError,
} from "./core-pass.ts";
import type {
	CoreFunctionPass,
	CoreFunctionPassAdmissionContext,
	CoreOptimizationStage,
} from "./core-pass.ts";
import type { CoreChangeSet, CoreProgram } from "./core-store.ts";

interface PendingLocalWork {
	full: boolean;
	readonly changes: Array<CoreChangeSet>;
}

interface PassConsumption {
	workItems: number;
	edits: number;
	exhausted: boolean;
}

const PASS_PENDING = 1;
const PASS_UNCHANGED = 2;

interface CoreFunctionPassSeedOptions {
	readonly seedLocalFromInitialChanges?: boolean;
}

export interface CoreFunctionPassSchedulerOptions {
	readonly verification?: CoreVerificationProfile;
	readonly optionalMaxRunsPerWorkItem?: number;
	readonly localOptimization?: boolean;
	readonly localOptimizationReportName?: string;
	readonly featureIndex?: CoreFunctionFeatureIndex;
	readonly localRules?: CoreLocalRuleRegistry;
	readonly localOptimizationBudget?: Pick<
		CoreLocalOptimizerOptions,
		"maxWorkItems" | "maxEdits" | "budgetExhaustion"
	>;
}

function wakesForChanges(pass: CoreFunctionPass, changes: CoreChangeSet): boolean {
	for (const wake of pass.wakesOn) {
		if (changes.domains.includes(wake as never)) return true;
		if (changes.programDomains.includes(wake as never)) return true;
	}
	return false;
}

function passOwner(pass: CoreFunctionPass): CoreOptimizationOwnerId {
	switch (pass.name) {
		case "block-parameter-simplification":
		case "unused-block-parameter-elimination":
		case "canonical-block-parameter-elimination":
			return CORE_OPTIMIZATION_OWNER.blockParameterSimplification;
		case "forwarding-block-elimination":
		case "linear-block-merging":
			return CORE_OPTIMIZATION_OWNER.forwardingAndLinearBlockNormalization;
		default:
			return CORE_OPTIMIZATION_OWNER.otherFunctionOptimizationPasses;
	}
}

export class CoreFunctionPassScheduler {
	readonly #program: CoreProgram;
	readonly #context: CoreCompilationContext;
	readonly #analyses: CoreAnalysisManager;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #functionId: CoreFunctionId;
	readonly #verification: CoreVerificationProfile;
	readonly #optionalMaxRunsPerWorkItem: number;
	readonly #localOptimization: boolean;
	readonly #localOptimizationReportName: string;
	readonly #localRules: CoreLocalRuleRegistry | undefined;
	readonly #localBudget: CoreFunctionPassSchedulerOptions["localOptimizationBudget"];
	readonly #features: CoreFunctionFeatureIndex;
	readonly #passOpcodeIds = new WeakMap<CoreFunctionPass, ReadonlyArray<CoreOpcodeId>>();
	readonly #passContexts = new WeakMap<CoreFunctionPass, CoreFunctionPassContextDriver>();
	readonly #admissionContext: CoreFunctionPassAdmissionContext;
	#localSeeded = false;

	constructor(
		program: CoreProgram,
		context: CoreCompilationContext,
		analyses: CoreAnalysisManager,
		report: CoreOptimizationReportBuilder,
		functionId: CoreFunctionId,
		options: CoreFunctionPassSchedulerOptions = {},
	) {
		program.function(functionId);
		this.#program = program;
		this.#context = context;
		this.#analyses = analyses;
		this.#report = report;
		this.#functionId = functionId;
		this.#admissionContext = Object.freeze({
			program,
			compilationContext: context,
			function: functionId,
		});
		this.#verification = options.verification ?? "boundary";
		this.#optionalMaxRunsPerWorkItem =
			options.optionalMaxRunsPerWorkItem ?? Number.MAX_SAFE_INTEGER;
		this.#localOptimization = options.localOptimization ?? false;
		this.#localBudget = options.localOptimizationBudget;
		this.#localOptimizationReportName =
			options.localOptimizationReportName ?? "fused-local-optimizer";
		this.#localRules = this.#localOptimization
			? (options.localRules ?? new CoreLocalRuleRegistry(program))
			: undefined;
		this.#features =
			options.featureIndex ??
			new CoreFunctionFeatureIndex(program, this.#localRules?.dispatch);
		if (
			!Number.isSafeInteger(this.#optionalMaxRunsPerWorkItem) ||
			this.#optionalMaxRunsPerWorkItem < 1
		) {
			throw new Error("Core pass work-item run limit must be a positive integer");
		}
	}

	runComponent(
		stage: CoreOptimizationStage,
		passes: ReadonlyArray<CoreFunctionPass>,
		initialChanges?: ReadonlyArray<CoreChangeSet>,
		seed: CoreFunctionPassSeedOptions = {},
	): ReadonlyArray<CoreChangeSet> {
		for (const pass of passes) this.#validatePass(stage, pass);
		const localKey = passes.length;
		const queue: Array<number> = [];
		const deferred: Array<number> = [];
		let queueIndex = 0;
		let deferredIndex = 0;
		const status = new Uint8Array(passes.length + 1);
		const runs =
			this.#optionalMaxRunsPerWorkItem === Number.MAX_SAFE_INTEGER
				? undefined
				: new Uint32Array(passes.length);
		const profileExhausted = new Uint8Array(passes.length);
		const consumption = new Array<PassConsumption | undefined>(passes.length);
		let pendingLocal: PendingLocalWork | undefined;
		const appliedChanges: Array<CoreChangeSet> = [];
		const enqueuePass = (passIndex: number): void => {
			const pass = passes[passIndex]!;
			const previous = status[passIndex]!;
			if ((previous & PASS_PENDING) !== 0) return;
			if (
				pass.budget.exhaustion === "stop" &&
				runs !== undefined &&
				runs[passIndex]! >= this.#optionalMaxRunsPerWorkItem
			) {
				if (profileExhausted[passIndex] === 0) {
					profileExhausted[passIndex] = 1;
					this.#report.recordBudgetExhaustion(pass.name);
				}
				return;
			}
			if (
				pass.requiredFunctionFeatures !== undefined &&
				(this.#features.get(this.#functionId) & pass.requiredFunctionFeatures) !==
					pass.requiredFunctionFeatures
			)
				return;
			if (
				pass.requiredFunctionOpcodesAny !== undefined &&
				!this.#features.hasAnyOpcode(this.#functionId, this.#opcodeIds(pass))
			)
				return;
			status[passIndex] = previous | PASS_PENDING;
			// An admission rejection is also an unchanged visit. Accumulate its
			// wakes while other work settles, then reconsider the current function.
			if (pass.budget.exhaustion === "stop" && previous === PASS_UNCHANGED)
				deferred.push(passIndex);
			else queue.push(passIndex);
			this.#report.recordQueuePush(
				queue.length - queueIndex + deferred.length - deferredIndex,
			);
		};
		const enqueueLocal = (changes?: CoreChangeSet): void => {
			if (!this.#localOptimization) return;
			if (
				(this.#features.get(this.#functionId) &
					(CORE_FUNCTION_HAS_BRANCHES | CORE_FUNCTION_HAS_CANDIDATE_OPCODES)) ===
				0
			)
				return;
			pendingLocal ??= { full: false, changes: [] };
			if (changes === undefined) pendingLocal.full = true;
			else pendingLocal.changes.push(changes);
			if (status[localKey] !== 0) return;
			status[localKey] = PASS_PENDING;
			queue.push(localKey);
			this.#report.recordQueuePush(
				queue.length - queueIndex + deferred.length - deferredIndex,
			);
		};
		const enqueueChanges = (changes: CoreChangeSet, enqueueLocalWork = true): void => {
			if (changes.function !== this.#functionId) {
				throw new Error(
					`Core function scheduler ${this.#functionId} received changes for ${changes.function}`,
				);
			}
			if (enqueueLocalWork) enqueueLocal(changes);
			for (let passIndex = 0; passIndex < passes.length; passIndex++) {
				if (wakesForChanges(passes[passIndex]!, changes)) enqueuePass(passIndex);
			}
		};
		if (initialChanges === undefined) {
			for (let passIndex = 0; passIndex < passes.length; passIndex++)
				enqueuePass(passIndex);
			if (stage === "canonicalize" && !this.#localSeeded) {
				enqueueLocal();
				this.#localSeeded = true;
			}
		} else {
			for (const changes of initialChanges) {
				enqueueChanges(changes, seed.seedLocalFromInitialChanges !== false);
			}
		}
		while (queueIndex < queue.length || deferredIndex < deferred.length) {
			const key =
				queueIndex < queue.length ? queue[queueIndex++]! : deferred[deferredIndex++]!;
			status[key] = 0;
			this.#report.recordQueuePop();
			if (key === localKey) {
				const pending = pendingLocal;
				pendingLocal = undefined;
				if (pending === undefined) continue;
				const result = this.#report.measureOwner(
					CORE_OPTIMIZATION_OWNER.fusedLocalOptimization,
					() =>
						new CoreLocalOptimizer(this.#program, this.#functionId, {
							...this.#localBudget,
							ruleRegistry: this.#localRules!,
						}).run(pending.full ? undefined : pending.changes),
				);
				this.#report.recordOwnerWork(
					CORE_OPTIMIZATION_OWNER.fusedLocalOptimization,
					result.statistics.rulesConsidered,
				);
				this.#report.recordLocalOptimizerWork(
					this.#localOptimizationReportName,
					result.statistics,
				);
				const changes = result.changes;
				if (changes === undefined || changes.edits === 0) continue;
				appliedChanges.push(changes);
				if (this.#verification === "per-pass") {
					verifyCoreChangeSet(this.#program, changes, {
						stage,
						pass: this.#localOptimizationReportName,
						functionIndex: changes.function,
					});
				}
				enqueueChanges(changes);
				continue;
			}
			const pass = passes[key]!;
			const admission = pass.admission;
			if (
				admission !== undefined &&
				"hasOpportunity" in admission &&
				!admission.hasOpportunity(this.#admissionContext)
			) {
				status[key] = PASS_UNCHANGED;
				continue;
			}
			const candidateContext =
				pass.candidates === undefined ? undefined : this.#passContext(pass);
			const candidates = candidateContext?.candidateInstructions();
			if (candidates?.length === 0) {
				status[key] = PASS_UNCHANGED;
				continue;
			}
			const run =
				admission !== undefined && "prepare" in admission
					? admission.prepare(this.#admissionContext, candidates)
					: pass.run;
			if (run === undefined) {
				status[key] = PASS_UNCHANGED;
				continue;
			}
			if (runs !== undefined) runs[key] = runs[key]! + 1;
			const used = consumption[key] ?? {
				workItems: 0,
				edits: 0,
				exhausted: false,
			};
			if (used.exhausted) continue;
			if (
				used.workItems >= pass.budget.maxWorkItems ||
				used.edits >= pass.budget.maxEdits
			) {
				this.#exhaust(pass, used);
				consumption[key] = used;
				continue;
			}
			const passStartedAt = this.#report.collectsDetails ? Date.now() : 0;
			const remainingEdits = pass.budget.maxEdits - used.edits;
			const owner = passOwner(pass);
			const passContext = candidateContext ?? this.#passContext(pass);
			const context = passContext.prepare(remainingEdits);
			const changes = this.#report.collectsDetails
				? this.#report.measureOwner(owner, () => run(context))
				: run(context);
			this.#report.recordOwnerWork(owner, 1);
			const elapsedMs = this.#report.collectsDetails ? Date.now() - passStartedAt : 0;
			const edits = changes?.edits ?? 0;
			used.workItems++;
			used.edits += edits;
			if (edits === 0) status[key] = PASS_UNCHANGED;
			if (pass.budget.exhaustion === "error" && used.edits > pass.budget.maxEdits)
				this.#exhaust(pass, used);
			consumption[key] = used;
			this.#report.recordPassRun(pass.name, 1, edits > 0, edits, elapsedMs);
			this.#report.recordBudget(1, edits);
			if (changes === undefined || edits === 0) continue;
			appliedChanges.push(changes);
			this.#validateChanges(pass, changes);
			if (this.#verification === "per-pass") {
				verifyCoreChangeSet(this.#program, changes, {
					stage,
					pass: pass.name,
					functionIndex: changes.function,
				});
			}
			enqueueChanges(changes);
		}
		return appliedChanges;
	}

	#validatePass(stage: CoreOptimizationStage, pass: CoreFunctionPass): void {
		if (pass.stage !== stage) {
			throw new Error(`Core pass ${pass.name} belongs to ${pass.stage}, not ${stage}`);
		}
		if (pass.name.length === 0) throw new Error("Core pass name is empty");
		if (
			pass.requiredFunctionFeatures !== undefined &&
			((pass.requiredFunctionFeatures & ~CORE_FUNCTION_FEATURE_MASK) !== 0 ||
				pass.requiredFunctionFeatures === 0)
		) {
			throw new Error(`Core pass ${pass.name} has an invalid function feature gate`);
		}
		if (
			pass.requiredFunctionOpcodesAny !== undefined &&
			pass.requiredFunctionOpcodesAny.length === 0
		) {
			throw new Error(`Core pass ${pass.name} has an invalid function opcode gate`);
		}
		if (pass.admission !== undefined && pass.admission.predicate.length === 0) {
			throw new Error(`Core pass ${pass.name} has an unnamed admission predicate`);
		}
		if (pass.candidates !== undefined && !pass.candidates.dependencies.includes("body")) {
			throw new Error(`Core pass ${pass.name} candidates must depend on the body`);
		}
		if (pass.requiredAnalyses.some((analysis) => analysis.scope !== "function")) {
			throw new Error(`Core function pass ${pass.name} requires a non-function analysis`);
		}
		if (
			!Number.isSafeInteger(pass.budget.maxWorkItems) ||
			pass.budget.maxWorkItems < 1 ||
			!Number.isSafeInteger(pass.budget.maxEdits) ||
			pass.budget.maxEdits < 0
		) {
			throw new Error(`Core pass ${pass.name} has an invalid work budget`);
		}
	}

	#opcodeIds(pass: CoreFunctionPass): ReadonlyArray<CoreOpcodeId> {
		let ids = this.#passOpcodeIds.get(pass);
		if (ids !== undefined) return ids;
		ids = pass.requiredFunctionOpcodesAny!.flatMap((opcode) => {
			const descriptor = this.#program.registry.get(opcode);
			return descriptor === undefined ? [] : [descriptor.id];
		});
		this.#passOpcodeIds.set(pass, ids);
		return ids;
	}

	#passContext(pass: CoreFunctionPass): CoreFunctionPassContextDriver {
		let context = this.#passContexts.get(pass);
		if (context === undefined) {
			context = new CoreFunctionPassContextDriver(
				this.#program,
				this.#context,
				this.#analyses,
				pass,
				this.#functionId,
			);
			this.#passContexts.set(pass, context);
		}
		return context;
	}

	#validateChanges(pass: CoreFunctionPass, changes: CoreChangeSet): void {
		if (changes.function !== this.#functionId) {
			throw new Error(
				`Core function pass ${pass.name} changed ${changes.function} in scheduler ${this.#functionId}`,
			);
		}
		for (const domain of changes.domains) {
			if (
				(domain === "cfg" && !pass.changes.cfg) ||
				(domain === "calls" && !pass.changes.calls) ||
				(domain === "facts" && !pass.changes.facts) ||
				(domain === "representations" && !pass.changes.representations)
			) {
				throw new Error(`Core pass ${pass.name} changed undeclared domain ${domain}`);
			}
		}
	}

	#exhaust(pass: CoreFunctionPass, consumption: PassConsumption): void {
		this.#report.recordBudgetExhaustion(pass.name);
		if (pass.budget.exhaustion === "error") {
			throw new CoreOptimizationBudgetError(
				`Required Core pass ${pass.name} exhausted its work budget`,
			);
		}
		consumption.exhausted = true;
	}
}
