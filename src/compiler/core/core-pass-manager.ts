import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_CONTROL_FLOW_PASSES } from "./core-control-flow-passes.ts";
import type { CoreEditor } from "./core-editor.ts";
import {
	CORE_FUNCTION_HAS_BRANCHES,
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
	CORE_FUNCTION_FEATURE_MASK,
	CoreFunctionFeatureIndex,
} from "./core-function-features.ts";
import { verifyCoreChangeSet } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import { CoreLocalOptimizer, CoreLocalRuleRegistry } from "./core-local-optimizer.ts";
import type { CoreLocalOptimizerResult } from "./core-local-optimizer.ts";
import { CORE_MEMORY_PASSES } from "./core-memory-passes.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import { CorePassContextDriver } from "./core-pass.ts";
import type { CoreOptimizationStage, CorePass } from "./core-pass.ts";
import { CORE_PROOF_PASSES } from "./core-proof-passes.ts";
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

export interface CorePassManagerOptions {
	readonly verification?: CoreVerificationProfile;
	readonly optionalMaxRunsPerWorkItem?: number;
	readonly localOptimization?: boolean;
	readonly sccs?: ReadonlyArray<{
		readonly id: string;
		readonly functions: ReadonlyArray<number>;
	}>;
}

function wakesForChanges(pass: CorePass, changes: CoreChangeSet): boolean {
	for (const wake of pass.wakesOn) {
		if (changes.domains.includes(wake as never)) return true;
		if (changes.programDomains.includes(wake as never)) return true;
	}
	return false;
}

export class CorePassManager {
	readonly #program: CoreProgram;
	readonly #context: CoreCompilationContext;
	readonly #analyses: CoreAnalysisManager;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #verification: CoreVerificationProfile;
	readonly #optionalMaxRunsPerWorkItem: number;
	readonly #localOptimization: boolean;
	readonly #localRules: CoreLocalRuleRegistry | undefined;
	readonly #features: CoreFunctionFeatureIndex;
	readonly #passContexts = new WeakMap<CorePass, CorePassContextDriver>();
	#localSeeded = false;
	readonly #sccs: ReadonlyArray<{
		readonly id: string;
		readonly functions: ReadonlyArray<number>;
	}>;

	constructor(
		program: CoreProgram,
		context: CoreCompilationContext,
		analyses: CoreAnalysisManager,
		report: CoreOptimizationReportBuilder,
		options: CorePassManagerOptions = {},
	) {
		this.#program = program;
		this.#context = context;
		this.#analyses = analyses;
		this.#report = report;
		this.#verification = options.verification ?? "boundary";
		this.#optionalMaxRunsPerWorkItem =
			options.optionalMaxRunsPerWorkItem ?? Number.MAX_SAFE_INTEGER;
		this.#localOptimization = options.localOptimization ?? false;
		this.#localRules = this.#localOptimization
			? new CoreLocalRuleRegistry(program)
			: undefined;
		this.#features = new CoreFunctionFeatureIndex(program, this.#localRules?.dispatch);
		if (
			!Number.isSafeInteger(this.#optionalMaxRunsPerWorkItem) ||
			this.#optionalMaxRunsPerWorkItem < 1
		) {
			throw new Error("Core pass work-item run limit must be a positive integer");
		}
		this.#sccs = options.sccs ?? [];
	}

	finishCrossCallCaller(editor: CoreEditor): CoreLocalOptimizerResult {
		if (editor.program !== this.#program) {
			throw new Error("Cross-call editor belongs to another Core program");
		}
		const result = new CoreLocalOptimizer(this.#program, editor.function.id, {
			ruleRegistry: this.#localRules ?? new CoreLocalRuleRegistry(this.#program),
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
				functionIndex: result.changes.function,
			});
		}
		return result;
	}

	finishCrossCallWave(changes: ReadonlyArray<CoreChangeSet>): void {
		this.runStage(
			"control-flow",
			CORE_CONTROL_FLOW_PASSES,
			changes,
			"control-flow",
			false,
		);
		this.runStage("proofs", CORE_PROOF_PASSES, changes, "proofs", false);
		this.runStage("memory", CORE_MEMORY_PASSES, changes, "memory", false);
	}

	runStage(
		stage: CoreOptimizationStage,
		passes: ReadonlyArray<CorePass>,
		initialChanges?: ReadonlyArray<CoreChangeSet>,
		reportedStage: CoreOptimizationStage = stage,
		seedLocalFromInitialChanges = true,
	): ReadonlyArray<CoreChangeSet> {
		for (const pass of passes) this.#validatePass(stage, pass);
		const startedAt = this.#report.collectsCounters ? Date.now() : 0;
		const functionStride = Math.max(1, this.#program.functionCapacity);
		const sccStride = Math.max(1, this.#sccs.length);
		const sccBase = passes.length * functionStride;
		const programBase = sccBase + passes.length * sccStride;
		const localBase = programBase + passes.length;
		const queueCapacity = localBase + functionStride;
		const queue: Array<number> = [];
		let queueIndex = 0;
		const queued = new Uint8Array(queueCapacity);
		const runs =
			this.#optionalMaxRunsPerWorkItem === Number.MAX_SAFE_INTEGER
				? undefined
				: new Uint32Array(queueCapacity);
		const profileExhausted = new Uint8Array(queueCapacity);
		const consumption = new Array<PassConsumption | undefined>(passes.length);
		const pendingLocal = new Map<CoreFunctionId, PendingLocalWork>();
		const appliedChanges: Array<CoreChangeSet> = [];
		const enqueuePass = (passIndex: number, key: number): void => {
			const pass = passes[passIndex]!;
			if (queued[key] !== 0) return;
			if (
				pass.budget.exhaustion === "stop" &&
				runs !== undefined &&
				runs[key]! >= this.#optionalMaxRunsPerWorkItem
			) {
				if (profileExhausted[key] === 0) {
					profileExhausted[key] = 1;
					this.#report.recordBudgetExhaustion(pass.name);
				}
				return;
			}
			queued[key] = 1;
			queue.push(key);
			this.#report.recordQueuePush(queue.length - queueIndex);
		};
		const enqueueFunction = (passIndex: number, functionId: CoreFunctionId): void => {
			const pass = passes[passIndex]!;
			if (
				pass.requiredFunctionFeatures !== undefined &&
				(this.#features.get(functionId) & pass.requiredFunctionFeatures) !==
					pass.requiredFunctionFeatures
			)
				return;
			enqueuePass(passIndex, passIndex * functionStride + functionId);
		};
		const enqueueScc = (passIndex: number, sccIndex: number): void => {
			enqueuePass(passIndex, sccBase + passIndex * sccStride + sccIndex);
		};
		const enqueueProgram = (passIndex: number): void => {
			enqueuePass(passIndex, programBase + passIndex);
		};
		const enqueueLocal = (functionId: CoreFunctionId, changes?: CoreChangeSet): void => {
			if (!this.#localOptimization) return;
			if (
				(this.#features.get(functionId) &
					(CORE_FUNCTION_HAS_BRANCHES | CORE_FUNCTION_HAS_CANDIDATE_OPCODES)) ===
				0
			) {
				return;
			}
			const pending = pendingLocal.get(functionId) ?? { full: false, changes: [] };
			if (changes === undefined) pending.full = true;
			else pending.changes.push(changes);
			pendingLocal.set(functionId, pending);
			const key = localBase + functionId;
			if (queued[key] !== 0) return;
			queued[key] = 1;
			queue.push(key);
			this.#report.recordQueuePush(queue.length - queueIndex);
		};
		const enqueueChanges = (changes: CoreChangeSet, enqueueLocalWork = true): void => {
			if (enqueueLocalWork) enqueueLocal(changes.function, changes);
			for (let passIndex = 0; passIndex < passes.length; passIndex++) {
				const pass = passes[passIndex]!;
				if (!wakesForChanges(pass, changes)) continue;
				switch (pass.scope) {
					case "function":
						enqueueFunction(passIndex, changes.function);
						break;
					case "scc":
						for (let sccIndex = 0; sccIndex < this.#sccs.length; sccIndex++) {
							if (this.#sccs[sccIndex]!.functions.includes(changes.function)) {
								enqueueScc(passIndex, sccIndex);
							}
						}
						break;
					case "program":
						enqueueProgram(passIndex);
						break;
				}
			}
		};
		if (initialChanges === undefined) {
			for (let passIndex = 0; passIndex < passes.length; passIndex++) {
				switch (passes[passIndex]!.scope) {
					case "function":
						for (const functionId of this.#program.functionIds()) {
							enqueueFunction(passIndex, functionId);
						}
						break;
					case "scc":
						for (let sccIndex = 0; sccIndex < this.#sccs.length; sccIndex++) {
							enqueueScc(passIndex, sccIndex);
						}
						break;
					case "program":
						enqueueProgram(passIndex);
						break;
				}
			}
			if (stage === "canonicalize" && !this.#localSeeded) {
				for (const functionId of this.#program.functionIds()) enqueueLocal(functionId);
				this.#localSeeded = true;
			}
		} else {
			for (const changes of initialChanges) {
				enqueueChanges(changes, seedLocalFromInitialChanges);
			}
		}
		while (queueIndex < queue.length) {
			const key = queue[queueIndex++]!;
			queued[key] = 0;
			this.#report.recordQueuePop();
			if (key >= localBase) {
				const functionId = (key - localBase) as CoreFunctionId;
				const pending = pendingLocal.get(functionId);
				pendingLocal.delete(functionId);
				if (pending === undefined) continue;
				const result = new CoreLocalOptimizer(this.#program, functionId, {
					ruleRegistry: this.#localRules!,
				}).run(pending.full ? undefined : pending.changes);
				this.#report.recordLocalOptimizerWork("fused-local-optimizer", result.statistics);
				const changes = result.changes;
				if (changes === undefined || changes.edits === 0) continue;
				appliedChanges.push(changes);
				if (this.#verification === "per-pass") {
					verifyCoreChangeSet(this.#program, changes, {
						stage,
						pass: "fused-local-optimizer",
						functionIndex: changes.function,
					});
				}
				enqueueChanges(changes);
				continue;
			}
			let passIndex: number;
			let passContext: CorePassContextDriver | undefined;
			if (key < sccBase) passIndex = Math.floor(key / functionStride);
			else if (key < programBase) {
				passIndex = Math.floor((key - sccBase) / sccStride);
			} else passIndex = key - programBase;
			const pass = passes[passIndex]!;
			if (runs !== undefined) runs[key] = runs[key]! + 1;
			const used = consumption[passIndex] ?? {
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
				consumption[passIndex] = used;
				continue;
			}
			const passStartedAt = this.#report.collectsDetails ? Date.now() : 0;
			passContext = this.#passContexts.get(pass);
			if (passContext === undefined) {
				passContext = new CorePassContextDriver(
					this.#program,
					this.#context,
					this.#analyses,
					pass,
				);
				this.#passContexts.set(pass, passContext);
			}
			const remainingEdits = pass.budget.maxEdits - used.edits;
			const changes =
				key < sccBase
					? pass.run(
							passContext.prepareFunction(
								(key % functionStride) as CoreFunctionId,
								remainingEdits,
							),
						)
					: key < programBase
						? pass.run(
								passContext.prepareScc(
									(key - sccBase) % sccStride,
									this.#sccs[(key - sccBase) % sccStride]!.id,
									this.#sccs[(key - sccBase) % sccStride]!.functions as never,
									remainingEdits,
								),
							)
						: pass.run(passContext.prepareProgram(remainingEdits));
			const elapsedMs = this.#report.collectsDetails ? Date.now() - passStartedAt : 0;
			const edits = changes?.edits ?? 0;
			used.workItems++;
			used.edits += edits;
			consumption[passIndex] = used;
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
		if (this.#report.collectsCounters) {
			this.#report.recordStage(reportedStage, Date.now() - startedAt);
		}
		return appliedChanges;
	}

	#validatePass(stage: CoreOptimizationStage, pass: CorePass): void {
		if (pass.stage !== stage) {
			throw new Error(`Core pass ${pass.name} belongs to ${pass.stage}, not ${stage}`);
		}
		if (pass.name.length === 0) throw new Error("Core pass name is empty");
		if (
			pass.requiredFunctionFeatures !== undefined &&
			((pass.requiredFunctionFeatures & ~CORE_FUNCTION_FEATURE_MASK) !== 0 ||
				pass.requiredFunctionFeatures === 0 ||
				pass.scope === "scc" ||
				pass.scope === "program")
		) {
			throw new Error(`Core pass ${pass.name} has an invalid function feature gate`);
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

	#validateChanges(pass: CorePass, changes: CoreChangeSet): void {
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

	#exhaust(pass: CorePass, consumption: PassConsumption): void {
		this.#report.recordBudgetExhaustion(pass.name);
		if (pass.budget.exhaustion === "error") {
			throw new Error(`Required Core pass ${pass.name} exhausted its work budget`);
		}
		consumption.exhausted = true;
	}
}
