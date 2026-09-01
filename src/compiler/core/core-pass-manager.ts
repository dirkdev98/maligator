import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { verifyCoreChangeSet } from "./core-ir-verifier.ts";
import type { CoreVerificationProfile } from "./core-ir-verifier.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import {
	coreAnalysisRequestForPass,
	corePassContext,
} from "./core-pass.ts";
import type {
	CoreOptimizationStage,
	CorePass,
	CorePassWorkItem,
} from "./core-pass.ts";
import type { CoreChangeSet, CoreProgram } from "./core-store.ts";

interface QueuedPassWork {
	readonly pass: CorePass;
	readonly item: CorePassWorkItem;
	readonly key: string;
}

interface PassConsumption {
	workItems: number;
	edits: number;
	exhausted: boolean;
}

export interface CorePassManagerOptions {
	readonly verification?: CoreVerificationProfile;
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

function intersects(
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
): boolean {
	return left.some((entry) => right.includes(entry));
}

export class CorePassManager {
	readonly #program: CoreProgram;
	readonly #context: CoreCompilationContext;
	readonly #analyses: CoreAnalysisManager;
	readonly #report: CoreOptimizationReportBuilder;
	readonly #verification: CoreVerificationProfile;
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
		this.#sccs = options.sccs ?? [];
	}

	runStage(
		stage: CoreOptimizationStage,
		passes: ReadonlyArray<CorePass>,
		initialChanges?: ReadonlyArray<CoreChangeSet>,
	): void {
		for (const pass of passes) this.#validatePass(stage, pass);
		const startedAt = performance.now();
		const queue: Array<QueuedPassWork> = [];
		const queued = new Set<string>();
		const consumption = new Map<string, PassConsumption>();
		const enqueue = (pass: CorePass, item: CorePassWorkItem): void => {
			const key = workKey(pass, item);
			if (queued.has(key)) return;
			queued.add(key);
			queue.push({ pass, item, key });
			this.#report.recordQueuePush(queue.length);
		};
		const enqueueChanges = (changes: CoreChangeSet): void => {
			const wakeKinds = [...changes.domains, ...changes.programDomains];
			for (const pass of passes) {
				if (!intersects(pass.wakesOn, wakeKinds)) continue;
				this.#enqueueChangedWork(pass, changes, enqueue);
			}
		};
		if (initialChanges === undefined) {
			for (const pass of passes) this.#enqueueInitialWork(pass, enqueue);
		} else {
			for (const changes of initialChanges) enqueueChanges(changes);
		}

		while (queue.length > 0) {
			const work = queue.shift()!;
			queued.delete(work.key);
			this.#report.recordQueuePop();
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
			for (const analysis of work.pass.requiredAnalyses) {
				this.#analyses.get(
					analysis,
					coreAnalysisRequestForPass(analysis, work.item),
				);
			}
			const passStartedAt = performance.now();
			const changes = work.pass.run(
				corePassContext(
					this.#program,
					this.#context,
					this.#analyses,
					work.pass,
					work.item,
				),
			);
			const elapsedMs = performance.now() - passStartedAt;
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
					stage: "fixpoint",
					pass: work.pass.name,
					functionIndex: changes.function,
				});
			}
			enqueueChanges(changes);
		}
		this.#report.recordStage(stage, performance.now() - startedAt);
	}

	#enqueueInitialWork(
		pass: CorePass,
		enqueue: (pass: CorePass, item: CorePassWorkItem) => void,
	): void {
		switch (pass.scope) {
			case "instruction":
				for (const functionId of this.#program.functionIds()) {
					for (const instruction of this.#program.function(functionId).instructionIds()) {
						enqueue(pass, { scope: "instruction", function: functionId, instruction });
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
				for (const value of changes.values) {
					if (!fn.isValueLive(value)) continue;
					const definition = fn.valueDefinition(value);
					if (definition.kind === "instruction") {
						instructions.add(definition.instruction);
					}
					for (const use of fn.uses(value)) instructions.add(use.instruction);
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
				for (const block of changes.blocks) {
					if (fn.isBlockLive(block)) {
						enqueue(pass, { scope: "block", function: changes.function, block });
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
