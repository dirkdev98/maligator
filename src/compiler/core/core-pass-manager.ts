import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_FUNCTION_FEATURE_MASK,
	CoreFunctionFeatureIndex,
} from "./core-function-features.ts";
import { verifyCoreChangeSet } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId } from "./core-ir.ts";
import { CoreLocalOptimizer } from "./core-local-optimizer.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import { corePassContext } from "./core-pass.ts";
import type { CoreOptimizationStage, CorePass, CorePassWorkItem } from "./core-pass.ts";
import type { CoreChangeSet, CoreProgram } from "./core-store.ts";

interface QueuedPassWork {
	readonly kind: "pass";
	readonly pass: CorePass;
	readonly item: CorePassWorkItem;
	readonly key: string;
}

interface QueuedLocalWork {
	readonly kind: "local";
	readonly function: CoreFunctionId;
	readonly key: string;
}

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

function workKey(pass: CorePass, item: CorePassWorkItem): string {
	switch (item.scope) {
		case "instruction":
			return `${pass.name}:instruction:${item.function}:${item.instruction}`;
		case "block":
			return `${pass.name}:block:${item.function}:${item.block}`;
		case "function":
			return `${pass.name}:function:${item.function}`;
		case "scc":
			return `${pass.name}:scc:${item.id}`;
		case "program":
			return `${pass.name}:program`;
	}
}

function intersects(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	return left.some((entry) => right.includes(entry));
}

export class CorePassManager {
	readonly #program: CoreProgram;
	readonly #context: CoreCompilationContext;
	readonly #analyses: CoreAnalysisManager;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #verification: CoreVerificationProfile;
	readonly #optionalMaxRunsPerWorkItem: number;
	readonly #localOptimization: boolean;
	readonly #features: CoreFunctionFeatureIndex;
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
		this.#features = new CoreFunctionFeatureIndex(program);
		if (
			!Number.isSafeInteger(this.#optionalMaxRunsPerWorkItem) ||
			this.#optionalMaxRunsPerWorkItem < 1
		) {
			throw new Error("Core pass work-item run limit must be a positive integer");
		}
		this.#sccs = options.sccs ?? [];
	}

	runStage(
		stage: CoreOptimizationStage,
		passes: ReadonlyArray<CorePass>,
		initialChanges?: ReadonlyArray<CoreChangeSet>,
	): void {
		for (const pass of passes) this.#validatePass(stage, pass);
		const startedAt = this.#report.collectsCounters ? Date.now() : 0;
		const queue: Array<QueuedPassWork | QueuedLocalWork | undefined> = [];
		let queueIndex = 0;
		const queued = new Set<string>();
		const runs =
			this.#optionalMaxRunsPerWorkItem === Number.MAX_SAFE_INTEGER
				? undefined
				: new Map<string, number>();
		const profileExhausted = new Set<string>();
		const consumption = new Map<string, PassConsumption>();
		const pendingLocal = new Map<CoreFunctionId, PendingLocalWork>();
		const enqueue = (pass: CorePass, item: CorePassWorkItem): void => {
			if (!this.#accepts(pass, item)) return;
			const key = workKey(pass, item);
			if (queued.has(key)) return;
			if (
				pass.budget.exhaustion === "stop" &&
				(runs?.get(key) ?? 0) >= this.#optionalMaxRunsPerWorkItem
			) {
				if (!profileExhausted.has(key)) {
					profileExhausted.add(key);
					this.#report.recordBudgetExhaustion(pass.name);
				}
				return;
			}
			queued.add(key);
			queue.push({ kind: "pass", pass, item, key });
			this.#report.recordQueuePush(queue.length - queueIndex);
		};
		const enqueueLocal = (functionId: CoreFunctionId, changes?: CoreChangeSet): void => {
			if (!this.#localOptimization) return;
			const pending = pendingLocal.get(functionId) ?? { full: false, changes: [] };
			if (changes === undefined) pending.full = true;
			else pending.changes.push(changes);
			pendingLocal.set(functionId, pending);
			const key = `local:function:${functionId}`;
			if (queued.has(key)) return;
			queued.add(key);
			queue.push({ kind: "local", function: functionId, key });
			this.#report.recordQueuePush(queue.length - queueIndex);
		};
		const enqueueChanges = (changes: CoreChangeSet): void => {
			enqueueLocal(changes.function, changes);
			const wakeKinds = [...changes.domains, ...changes.programDomains];
			for (const pass of passes) {
				if (!intersects(pass.wakesOn, wakeKinds)) continue;
				this.#enqueueChangedWork(pass, changes, enqueue);
			}
		};
		if (initialChanges === undefined) {
			for (const pass of passes) this.#enqueueInitialWork(pass, enqueue);
			if (stage === "canonicalize" && !this.#localSeeded) {
				for (const functionId of this.#program.functionIds()) enqueueLocal(functionId);
				this.#localSeeded = true;
			}
		} else {
			for (const changes of initialChanges) enqueueChanges(changes);
		}
		while (queueIndex < queue.length) {
			const work = queue[queueIndex]!;
			queue[queueIndex++] = undefined;
			queued.delete(work.key);
			this.#report.recordQueuePop();
			if (work.kind === "local") {
				const pending = pendingLocal.get(work.function);
				pendingLocal.delete(work.function);
				if (pending === undefined) continue;
				const result = new CoreLocalOptimizer(this.#program, work.function).run(
					pending.full ? undefined : pending.changes,
				);
				this.#report.recordLocalOptimizerWork("fused-local-optimizer", result.statistics);
				const changes = result.changes;
				if (changes === undefined || changes.edits === 0) continue;
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
			if (runs !== undefined) runs.set(work.key, (runs.get(work.key) ?? 0) + 1);
			const used = consumption.get(work.pass.name) ?? {
				workItems: 0,
				edits: 0,
				exhausted: false,
			};
			if (used.exhausted) continue;
			if (
				used.workItems >= work.pass.budget.maxWorkItems ||
				used.edits >= work.pass.budget.maxEdits
			) {
				this.#exhaust(work.pass, used);
				consumption.set(work.pass.name, used);
				continue;
			}
			const passStartedAt = this.#report.collectsDetails ? Date.now() : 0;
			const changes = work.pass.run(
				corePassContext(
					this.#program,
					this.#context,
					this.#analyses,
					work.pass,
					work.item,
					work.pass.budget.maxEdits - used.edits,
				),
			);
			const elapsedMs = this.#report.collectsDetails ? Date.now() - passStartedAt : 0;
			const edits = changes?.edits ?? 0;
			used.workItems++;
			used.edits += edits;
			consumption.set(work.pass.name, used);
			this.#report.recordPassRun(work.pass.name, 1, edits > 0, edits, elapsedMs);
			this.#report.recordBudget(1, edits);
			if (changes === undefined || edits === 0) continue;
			this.#validateChanges(work.pass, changes);
			if (this.#verification === "per-pass") {
				verifyCoreChangeSet(this.#program, changes, {
					stage,
					pass: work.pass.name,
					functionIndex: changes.function,
				});
			}
			enqueueChanges(changes);
		}
		if (this.#report.collectsCounters) {
			this.#report.recordStage(stage, Date.now() - startedAt);
		}
	}

	#enqueueInitialWork(
		pass: CorePass,
		enqueue: (pass: CorePass, item: CorePassWorkItem) => void,
	): void {
		switch (pass.scope) {
			case "instruction":
				for (const functionId of this.#program.functionIds()) {
					for (const instruction of this.#program.function(functionId).instructionIds()) {
						enqueue(pass, {
							scope: "instruction",
							function: functionId,
							instruction,
						});
					}
				}
				break;
			case "block":
				for (const functionId of this.#program.functionIds()) {
					for (const block of this.#program.function(functionId).blockIds()) {
						enqueue(pass, { scope: "block", function: functionId, block });
					}
				}
				break;
			case "function":
				for (const functionId of this.#program.functionIds()) {
					enqueue(pass, { scope: "function", function: functionId });
				}
				break;
			case "scc":
				for (const scc of this.#sccs) {
					enqueue(pass, {
						scope: "scc",
						id: scc.id,
						functions: scc.functions as never,
					});
				}
				break;
			case "program":
				enqueue(pass, { scope: "program" });
				break;
		}
	}

	#enqueueChangedWork(
		pass: CorePass,
		changes: CoreChangeSet,
		enqueue: (pass: CorePass, item: CorePassWorkItem) => void,
	): void {
		const fn = this.#program.function(changes.function);
		switch (pass.scope) {
			case "instruction": {
				const instructions = new Set(changes.instructions);
				for (const call of changes.calls) instructions.add(call);
				for (const edge of changes.edges) {
					for (const block of [edge.source, edge.target]) {
						if (!fn.isBlockLive(block)) continue;
						for (const instruction of fn.instructionIds(block)) {
							instructions.add(instruction);
						}
					}
				}
				for (const value of changes.values) {
					if (!fn.isValueLive(value)) continue;
					if (fn.kernel.valueDefinitionKind(value) === 1) {
						instructions.add(coreInstructionId(fn.kernel.valueDefinitionOwner(value)));
					}
					for (
						let use = fn.kernel.valueFirstUse(value);
						use >= 0;
						use = fn.kernel.useNext(use)
					) {
						instructions.add(fn.kernel.useInstruction(use));
					}
				}
				for (const instruction of instructions) {
					if (fn.isInstructionLive(instruction)) {
						enqueue(pass, {
							scope: "instruction",
							function: changes.function,
							instruction,
						});
					}
				}
				break;
			}
			case "block":
				for (const block of new Set([
					...changes.blocks,
					...changes.edges.flatMap(({ source, target }) => [source, target]),
				])) {
					if (fn.isBlockLive(block)) {
						enqueue(pass, {
							scope: "block",
							function: changes.function,
							block,
						});
					}
				}
				break;
			case "function":
				enqueue(pass, { scope: "function", function: changes.function });
				break;
			case "scc":
				for (const scc of this.#sccs) {
					if (!scc.functions.includes(changes.function)) continue;
					enqueue(pass, {
						scope: "scc",
						id: scc.id,
						functions: scc.functions as never,
					});
				}
				break;
			case "program":
				enqueue(pass, { scope: "program" });
				break;
		}
	}

	#validatePass(stage: CoreOptimizationStage, pass: CorePass): void {
		if (pass.stage !== stage) {
			throw new Error(`Core pass ${pass.name} belongs to ${pass.stage}, not ${stage}`);
		}
		if (pass.name.length === 0) throw new Error("Core pass name is empty");
		if (pass.instructionOpcodes !== undefined && pass.scope !== "instruction") {
			throw new Error(
				`Core pass ${pass.name} declares instruction opcodes for ${pass.scope} scope`,
			);
		}
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

	#accepts(pass: CorePass, item: CorePassWorkItem): boolean {
		if (
			pass.requiredFunctionFeatures !== undefined &&
			item.scope !== "program" &&
			item.scope !== "scc" &&
			(this.#features.get(item.function) & pass.requiredFunctionFeatures) !==
				pass.requiredFunctionFeatures
		) {
			return false;
		}
		if (item.scope !== "instruction" || pass.instructionOpcodes === undefined) {
			return true;
		}
		const fn = this.#program.function(item.function);
		return (
			fn.isInstructionLive(item.instruction) &&
			fn.instructionKind(item.instruction) === "operation" &&
			pass.instructionOpcodes.has(fn.instructionOpcode(item.instruction))
		);
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
