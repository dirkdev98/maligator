import type { CoreOptimizationPlan } from "./optimize.ts";
import type { CoreProgram } from "./core-store.ts";

export interface CoreOptimizationCounts {
	readonly functions: number;
	readonly blocks: number;
	readonly instructions: number;
	readonly values: number;
	readonly facts: number;
	readonly planCandidates: number;
}

export interface CoreOptimizationStageReport {
	readonly stage: string;
	readonly elapsedMs: number;
}

export interface CorePassWorkReport {
	readonly pass: string;
	readonly runs: number;
	readonly workItems: number;
	readonly changedItems: number;
	readonly edits: number;
	readonly elapsedMs: number;
}

export interface CoreAnalysisWorkReport {
	readonly analysis: string;
	readonly queries: number;
	readonly hits: number;
	readonly recomputations: number;
	readonly invalidations: number;
	readonly elapsedMs: number;
}

export interface CoreQueueWorkReport {
	readonly pushes: number;
	readonly pops: number;
	readonly maximumDepth: number;
}

export interface CoreBudgetWorkReport {
	readonly workItems: number;
	readonly edits: number;
	readonly exhaustedPasses: ReadonlyArray<string>;
}

export interface CoreOptimizationReport {
	readonly input: CoreOptimizationCounts;
	readonly output: CoreOptimizationCounts;
	readonly stages: ReadonlyArray<CoreOptimizationStageReport>;
	readonly passes: ReadonlyArray<CorePassWorkReport>;
	readonly analyses: ReadonlyArray<CoreAnalysisWorkReport>;
	readonly discovery: CoreCandidateDiscoveryReport;
	readonly program: CoreProgramWorkReport;
	readonly queue: CoreQueueWorkReport;
	readonly budget: CoreBudgetWorkReport;
}

export interface CoreProgramWorkReport {
	readonly functionsAnalyzed: number;
	readonly functionsReused: number;
	readonly callSites: number;
	readonly callEdges: number;
	readonly openCallSites: number;
	readonly sccs: number;
	readonly sccTransfers: number;
	readonly summaryChanges: number;
	readonly callerWakeups: number;
	readonly affectedCallers: number;
	readonly deadFunctions: number;
}

export interface CoreCandidateDiscoveryReport {
	readonly candidates: number;
	readonly stackObjects: number;
	readonly denseArrays: number;
	readonly numericFusions: number;
	readonly largestFanOut: number;
}

interface MutablePassWorkReport {
	runs: number;
	workItems: number;
	changedItems: number;
	edits: number;
	elapsedMs: number;
}

interface MutableAnalysisWorkReport {
	queries: number;
	hits: number;
	recomputations: number;
	invalidations: number;
	elapsedMs: number;
}

function liveCounts(program: CoreProgram): Omit<CoreOptimizationCounts, "planCandidates"> {
	let functions = 0;
	let blocks = 0;
	let instructions = 0;
	let values = 0;
	let facts = 0;
	for (const functionId of program.functionIds()) {
		functions++;
		const fn = program.function(functionId);
		blocks += [...fn.blockIds()].length;
		instructions += [...fn.instructionIds()].length;
		for (let value = 0; value < fn.valueCapacity; value++) {
			if (fn.isValueLive(value as never)) values++;
		}
		for (let fact = 0; fact < fn.factCapacity; fact++) {
			if (fn.isFactLive(fact as never)) facts++;
		}
	}
	return { functions, blocks, instructions, values, facts };
}

export function coreOptimizationCounts(
	program: CoreProgram,
	plan?: CoreOptimizationPlan,
): CoreOptimizationCounts {
	return {
		...liveCounts(program),
		planCandidates:
			(plan?.directEntries.length ?? 0) + (plan?.specializations.length ?? 0),
	};
}

export class CoreOptimizationReportBuilder {
	readonly input: CoreOptimizationCounts;
	readonly #stages: Array<CoreOptimizationStageReport> = [];
	readonly #passes = new Map<string, MutablePassWorkReport>();
	readonly #analyses = new Map<string, MutableAnalysisWorkReport>();
	readonly #exhaustedPasses = new Set<string>();
	#queuePushes = 0;
	#queuePops = 0;
	#queueMaximumDepth = 0;
	#budgetWorkItems = 0;
	#budgetEdits = 0;
	#discoveredStackObjects = 0;
	#discoveredDenseArrays = 0;
	#discoveredNumericFusions = 0;
	#largestCandidateFanOut = 0;
	#programWork: CoreProgramWorkReport = Object.freeze({
		functionsAnalyzed: 0,
		functionsReused: 0,
		callSites: 0,
		callEdges: 0,
		openCallSites: 0,
		sccs: 0,
		sccTransfers: 0,
		summaryChanges: 0,
		callerWakeups: 0,
		affectedCallers: 0,
		deadFunctions: 0,
	});

	constructor(program: CoreProgram) {
		this.input = Object.freeze(coreOptimizationCounts(program));
	}

	recordStage(stage: string, elapsedMs: number): void {
		this.#stages.push(Object.freeze({ stage, elapsedMs }));
	}

	recordPassRun(
		pass: string,
		workItems: number,
		changed: boolean,
		edits: number,
		elapsedMs: number,
	): void {
		const report = this.#passes.get(pass) ?? {
			runs: 0,
			workItems: 0,
			changedItems: 0,
			edits: 0,
			elapsedMs: 0,
		};
		report.runs++;
		report.workItems += workItems;
		if (changed) report.changedItems++;
		report.edits += edits;
		report.elapsedMs += elapsedMs;
		this.#passes.set(pass, report);
	}

	recordAnalysis(
		analysis: string,
		outcome: "hit" | "recompute",
		invalidated: boolean,
		elapsedMs: number,
	): void {
		const report = this.#analyses.get(analysis) ?? {
			queries: 0,
			hits: 0,
			recomputations: 0,
			invalidations: 0,
			elapsedMs: 0,
		};
		report.queries++;
		if (outcome === "hit") report.hits++;
		else report.recomputations++;
		if (invalidated) report.invalidations++;
		report.elapsedMs += elapsedMs;
		this.#analyses.set(analysis, report);
	}

	recordQueuePush(depth: number): void {
		this.#queuePushes++;
		this.#queueMaximumDepth = Math.max(this.#queueMaximumDepth, depth);
	}

	recordQueuePop(): void {
		this.#queuePops++;
	}

	recordBudget(workItems: number, edits: number): void {
		this.#budgetWorkItems += workItems;
		this.#budgetEdits += edits;
	}

	recordBudgetExhaustion(pass: string): void {
		this.#exhaustedPasses.add(pass);
	}

	recordCandidateDiscovery(
		candidates: ReadonlyArray<{
			readonly kind: "stack-object" | "dense-array" | "numeric-fusion";
			readonly fanOut: number;
		}>,
	): void {
		for (const candidate of candidates) {
			switch (candidate.kind) {
				case "stack-object": this.#discoveredStackObjects++; break;
				case "dense-array": this.#discoveredDenseArrays++; break;
				case "numeric-fusion": this.#discoveredNumericFusions++; break;
			}
			this.#largestCandidateFanOut = Math.max(
				this.#largestCandidateFanOut,
				candidate.fanOut,
			);
		}
	}

	recordProgramWork(
		callGraph: {
			readonly functionsAnalyzed: number;
			readonly functionsReused: number;
			readonly callSites: number;
			readonly callEdges: number;
			readonly openCallSites: number;
		},
		summaries: {
			readonly sccs: number;
			readonly sccTransfers: number;
			readonly summaryChanges: number;
			readonly callerWakeups: number;
			readonly affectedCallers: number;
		},
		reachability: { readonly deadFunctions: number },
	): void {
		this.#programWork = Object.freeze({
			functionsAnalyzed: callGraph.functionsAnalyzed,
			functionsReused: callGraph.functionsReused,
			callSites: callGraph.callSites,
			callEdges: callGraph.callEdges,
			openCallSites: callGraph.openCallSites,
			sccs: summaries.sccs,
			sccTransfers: summaries.sccTransfers,
			summaryChanges: summaries.summaryChanges,
			callerWakeups: summaries.callerWakeups,
			affectedCallers: summaries.affectedCallers,
			deadFunctions: reachability.deadFunctions,
		});
	}

	finish(program: CoreProgram, plan: CoreOptimizationPlan): CoreOptimizationReport {
		return Object.freeze({
			input: this.input,
			output: Object.freeze(coreOptimizationCounts(program, plan)),
			stages: Object.freeze([...this.#stages]),
			passes: Object.freeze(
				[...this.#passes.entries()].map(([pass, report]) =>
					Object.freeze({ pass, ...report }),
				),
			),
			analyses: Object.freeze(
				[...this.#analyses.entries()].map(([analysis, report]) =>
					Object.freeze({ analysis, ...report }),
				),
			),
			discovery: Object.freeze({
				candidates:
					this.#discoveredStackObjects +
					this.#discoveredDenseArrays +
					this.#discoveredNumericFusions,
				stackObjects: this.#discoveredStackObjects,
				denseArrays: this.#discoveredDenseArrays,
				numericFusions: this.#discoveredNumericFusions,
				largestFanOut: this.#largestCandidateFanOut,
			}),
			program: this.#programWork,
			queue: Object.freeze({
				pushes: this.#queuePushes,
				pops: this.#queuePops,
				maximumDepth: this.#queueMaximumDepth,
			}),
			budget: Object.freeze({
				workItems: this.#budgetWorkItems,
				edits: this.#budgetEdits,
				exhaustedPasses: Object.freeze([...this.#exhaustedPasses]),
			}),
		});
	}
}

function countsLine(counts: CoreOptimizationCounts): string {
	return `${counts.functions} functions, ${counts.blocks} blocks, ${counts.instructions} instructions, ${counts.values} values, ${counts.facts} facts, ${counts.planCandidates} candidates`;
}

export function formatCoreOptimizationReport(
	report: CoreOptimizationReport,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
	const passes = report.passes.length === 0
		? "none"
		: report.passes
				.map(
					(pass) =>
						`${pass.pass} ${pass.runs} runs/${pass.workItems} work/${pass.changedItems} changed/${pass.edits} edits/${pass.elapsedMs.toFixed(1)}ms`,
				)
				.join("; ");
	const analyses = report.analyses.length === 0
		? "none"
		: report.analyses
				.map(
					(analysis) =>
						`${analysis.analysis} ${analysis.queries} queries/${analysis.hits} hits/${analysis.recomputations} recomputes/${analysis.invalidations} invalidations/${analysis.elapsedMs.toFixed(1)}ms`,
				)
				.join("; ");
	return [
		{ label: "Core optimizer input", value: countsLine(report.input) },
		{ label: "Core optimizer output", value: countsLine(report.output) },
		{
			label: "Core optimizer stages",
			value: report.stages
				.map(({ stage, elapsedMs }) => `${stage} ${elapsedMs.toFixed(1)}ms`)
				.join(", "),
		},
		{ label: "Core optimizer passes", value: passes },
		{ label: "Core optimizer analyses", value: analyses },
		{
			label: "Core optimizer program",
			value: `${report.program.functionsAnalyzed} functions analyzed/${report.program.functionsReused} reused, ${report.program.callSites} callsites/${report.program.callEdges} edges/${report.program.openCallSites} open, ${report.program.sccs} SCCs/${report.program.sccTransfers} transfers, ${report.program.summaryChanges} summary changes/${report.program.callerWakeups} caller wakeups/${report.program.affectedCallers} callers, ${report.program.deadFunctions} dead omitted`,
		},
		{
			label: "Core optimizer discovery",
			value: `${report.discovery.candidates} candidates (${report.discovery.stackObjects} stack objects, ${report.discovery.denseArrays} dense arrays, ${report.discovery.numericFusions} numeric fusions), largest fan-out ${report.discovery.largestFanOut}`,
		},
		{
			label: "Core optimizer queue",
			value: `${report.queue.pushes} pushes, ${report.queue.pops} pops, depth ${report.queue.maximumDepth}`,
		},
		{
			label: "Core optimizer budget",
			value: `${report.budget.workItems} work items, ${report.budget.edits} edits, exhausted ${report.budget.exhaustedPasses.join(", ") || "none"}`,
		},
	];
}
