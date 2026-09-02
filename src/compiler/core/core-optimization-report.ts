import type {
	CoreOptimizationPlan,
	CoreOptimizationPlanStatistics,
} from "./core-ir-regions.ts";
import type { CoreProgram } from "./core-store.ts";

export type CoreInstrumentationMode = "off" | "counters" | "full";

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
	readonly instrumentation: CoreInstrumentationMode;
	readonly input: CoreOptimizationCounts;
	readonly output: CoreOptimizationCounts;
	readonly stages: ReadonlyArray<CoreOptimizationStageReport>;
	readonly passes: ReadonlyArray<CorePassWorkReport>;
	readonly analyses: ReadonlyArray<CoreAnalysisWorkReport>;
	readonly discovery: CoreCandidateDiscoveryReport;
	readonly program: CoreProgramWorkReport;
	readonly transforms: CoreTransformWorkReport;
	readonly plan: CorePlanWorkReport;
	readonly queue: CoreQueueWorkReport;
	readonly budget: CoreBudgetWorkReport;
	readonly counters: CoreCompilerWorkCounters;
}

export interface CoreCompilerWorkCounters {
	readonly analysisQueries: number;
	readonly analysisRecomputations: number;
	readonly localRulesConsidered: number;
	readonly localRulesApplied: number;
	readonly functionScans: number;
	readonly explicitCallEdges: number;
	readonly wildcardCallSources: number;
	readonly wildcardCallSites: number;
	readonly opaqueCallSites: number;
	readonly aggregateDependencies: number;
	readonly storedCallGraphRows: number;
	readonly wildcardAggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
	readonly sccNodes: number;
	readonly sccEdges: number;
	readonly sccTransfers: number;
	readonly localFactRebuilds: number;
	readonly provenanceRebuilds: number;
	readonly memoryAccesses: number;
	readonly memoryLocations: number;
	readonly memoryStateEntries: number;
	readonly memoryPhis: number;
	readonly specializationFunctionsScanned: number;
	readonly specializationCandidatesDiscovered: number;
	readonly specializationCandidatesSelected: number;
	readonly liveUseVisits: number;
	readonly deadUseSkips: number;
	readonly abandonedOperandStorage: number;
	readonly abandonedParameterStorage: number;
}

export interface CorePlanWorkReport {
	readonly discovered: number;
	readonly selected: number;
	readonly declined: number;
	readonly discoveredByKind: Readonly<Record<string, number>>;
	readonly selectedByKind: Readonly<Record<string, number>>;
	readonly declinedByReason: Readonly<Record<string, number>>;
	readonly generatedCodeConsumed: number;
	readonly compilerWorkConsumed: number;
	readonly verificationMs: number;
}

export interface CoreTransformWorkReport {
	readonly considered: number;
	readonly applied: number;
	readonly declined: number;
	readonly appliedByKind: Readonly<Record<string, number>>;
	readonly declinedByReason: Readonly<Record<string, number>>;
	readonly generatedCodeConsumed: number;
	readonly compilerWorkConsumed: number;
	readonly instructionsIntroduced: number;
	readonly blocksIntroduced: number;
	readonly callGraphFunctionsAnalyzed: number;
	readonly sccTransfers: number;
	readonly callerWakeups: number;
	readonly valueKindFunctionEvaluations: number;
	readonly valueKindFolds: number;
	readonly wildcardAggregateRecomputations: number;
	readonly exactReverseCallerVisits: number;
	readonly wildcardReverseCallerVisits: number;
}

export interface CoreProgramWorkReport {
	readonly functionsAnalyzed: number;
	readonly functionsReused: number;
	readonly callSites: number;
	readonly exactCallEdges: number;
	readonly wildcardCallers: number;
	readonly wildcardCallSites: number;
	readonly opaqueCallSites: number;
	readonly aggregateDependencies: number;
	readonly storedGraphRows: number;
	readonly sccs: number;
	readonly sccTransfers: number;
	readonly summaryChanges: number;
	readonly callerWakeups: number;
	readonly affectedCallers: number;
	readonly deadFunctions: number;
}

export interface CoreCandidateDiscoveryReport {
	readonly candidates: number;
	readonly byKind: Readonly<Record<string, number>>;
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

const COUNTER_KEYS = [
	"analysisQueries",
	"analysisRecomputations",
	"localRulesConsidered",
	"localRulesApplied",
	"functionScans",
	"explicitCallEdges",
	"wildcardCallSources",
	"wildcardCallSites",
	"opaqueCallSites",
	"aggregateDependencies",
	"storedCallGraphRows",
	"wildcardAggregateRecomputations",
	"exactReverseCallerVisits",
	"wildcardReverseCallerVisits",
	"sccNodes",
	"sccEdges",
	"sccTransfers",
	"localFactRebuilds",
	"provenanceRebuilds",
	"memoryAccesses",
	"memoryLocations",
	"memoryStateEntries",
	"memoryPhis",
	"specializationFunctionsScanned",
	"specializationCandidatesDiscovered",
	"specializationCandidatesSelected",
	"liveUseVisits",
	"deadUseSkips",
	"abandonedOperandStorage",
	"abandonedParameterStorage",
] as const satisfies ReadonlyArray<keyof CoreCompilerWorkCounters>;

type CoreCompilerWorkCounter = (typeof COUNTER_KEYS)[number];

const COUNTER_INDEX = new Map(COUNTER_KEYS.map((key, index) => [key, index] as const));

const EMPTY_COUNTS: CoreOptimizationCounts = Object.freeze({
	functions: 0,
	blocks: 0,
	instructions: 0,
	values: 0,
	facts: 0,
	planCandidates: 0,
});

function iterableCount(values: Iterable<unknown>): number {
	let count = 0;
	for (const _value of values) count++;
	return count;
}

function liveCounts(
	program: CoreProgram,
): Omit<CoreOptimizationCounts, "planCandidates"> {
	let functions = 0;
	let blocks = 0;
	let instructions = 0;
	let values = 0;
	let facts = 0;
	for (const functionId of program.functionIds()) {
		functions++;
		const fn = program.function(functionId);
		blocks += iterableCount(fn.blockIds());
		instructions += iterableCount(fn.instructionIds());
		values += iterableCount(fn.valueIds());
		facts += iterableCount(fn.factIds());
	}
	return { functions, blocks, instructions, values, facts };
}

export function coreOptimizationCounts(
	program: CoreProgram,
	plan?: Pick<CoreOptimizationPlan, "directEntries" | "specializations">,
): CoreOptimizationCounts {
	return {
		...liveCounts(program),
		planCandidates:
			(plan?.directEntries.length ?? 0) + (plan?.specializations.length ?? 0),
	};
}

export class CoreOptimizationReportBuilder {
	readonly instrumentation: CoreInstrumentationMode;
	readonly input: CoreOptimizationCounts;
	readonly #stages: Array<CoreOptimizationStageReport> = [];
	readonly #passes: Map<string, MutablePassWorkReport> | undefined;
	readonly #analyses: Map<string, MutableAnalysisWorkReport> | undefined;
	readonly #exhaustedPasses: Set<string> | undefined;
	readonly #counters = new Float64Array(COUNTER_KEYS.length);
	#queuePushes = 0;
	#queuePops = 0;
	#queueMaximumDepth = 0;
	#budgetWorkItems = 0;
	#budgetEdits = 0;
	#discoveredStackObjects = 0;
	#discoveredDenseArrays = 0;
	#discoveredNumericFusions = 0;
	readonly #discoveredCandidatesByKind: Map<string, number> | undefined;
	#largestCandidateFanOut = 0;
	#programWork: CoreProgramWorkReport = Object.freeze({
		functionsAnalyzed: 0,
		functionsReused: 0,
		callSites: 0,
		exactCallEdges: 0,
		wildcardCallers: 0,
		wildcardCallSites: 0,
		opaqueCallSites: 0,
		aggregateDependencies: 0,
		storedGraphRows: 0,
		sccs: 0,
		sccTransfers: 0,
		summaryChanges: 0,
		callerWakeups: 0,
		affectedCallers: 0,
		deadFunctions: 0,
	});
	#transformWork: CoreTransformWorkReport = Object.freeze({
		considered: 0,
		applied: 0,
		declined: 0,
		appliedByKind: Object.freeze({}),
		declinedByReason: Object.freeze({}),
		generatedCodeConsumed: 0,
		compilerWorkConsumed: 0,
		instructionsIntroduced: 0,
		blocksIntroduced: 0,
		callGraphFunctionsAnalyzed: 0,
		sccTransfers: 0,
		callerWakeups: 0,
		valueKindFunctionEvaluations: 0,
		valueKindFolds: 0,
		wildcardAggregateRecomputations: 0,
		exactReverseCallerVisits: 0,
		wildcardReverseCallerVisits: 0,
	});
	#planWork: CorePlanWorkReport = Object.freeze({
		discovered: 0,
		selected: 0,
		declined: 0,
		discoveredByKind: Object.freeze({}),
		selectedByKind: Object.freeze({}),
		declinedByReason: Object.freeze({}),
		generatedCodeConsumed: 0,
		compilerWorkConsumed: 0,
		verificationMs: 0,
	});

	constructor(program: CoreProgram, instrumentation: CoreInstrumentationMode = "full") {
		this.instrumentation = instrumentation;
		this.input =
			instrumentation === "off"
				? EMPTY_COUNTS
				: Object.freeze(coreOptimizationCounts(program));
		this.#passes = instrumentation === "full" ? new Map() : undefined;
		this.#analyses = instrumentation === "full" ? new Map() : undefined;
		this.#exhaustedPasses = instrumentation === "full" ? new Set() : undefined;
		this.#discoveredCandidatesByKind = instrumentation === "full" ? new Map() : undefined;
	}

	get collectsCounters(): boolean {
		return this.instrumentation !== "off";
	}

	get collectsDetails(): boolean {
		return this.instrumentation === "full";
	}

	increment(counter: CoreCompilerWorkCounter, value = 1): void {
		if (!this.collectsCounters) return;
		const index = COUNTER_INDEX.get(counter)!;
		this.#counters[index] = this.#counters[index]! + value;
	}

	recordStage(stage: string, elapsedMs: number): void {
		if (!this.collectsCounters) return;
		this.#stages.push(Object.freeze({ stage, elapsedMs }));
	}

	recordPassRun(
		pass: string,
		workItems: number,
		changed: boolean,
		edits: number,
		elapsedMs: number,
	): void {
		if (!this.collectsCounters) return;
		this.increment("localRulesConsidered", workItems);
		if (changed) this.increment("localRulesApplied");
		if (this.#passes === undefined) return;
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
		if (!this.collectsCounters) return;
		this.increment("analysisQueries");
		if (outcome === "recompute") this.increment("analysisRecomputations");
		if (outcome === "recompute" && analysis === "local-provenance") {
			this.increment("provenanceRebuilds");
		} else if (outcome === "recompute" && analysis.startsWith("local-")) {
			this.increment("localFactRebuilds");
		}
		if (this.#analyses === undefined) return;
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

	recordAnalysisResult(analysis: string, value: unknown): void {
		if (!this.collectsCounters || analysis !== "local-memory-versions") return;
		const statistics = (
			value as {
				readonly statistics?: {
					readonly accesses?: number;
					readonly partitions?: number;
					readonly stateEntries?: number;
					readonly phis?: number;
				};
			}
		).statistics;
		this.increment("memoryAccesses", statistics?.accesses ?? 0);
		this.increment("memoryLocations", statistics?.partitions ?? 0);
		this.increment("memoryStateEntries", statistics?.stateEntries ?? 0);
		this.increment("memoryPhis", statistics?.phis ?? 0);
	}

	recordQueuePush(depth: number): void {
		if (!this.collectsCounters) return;
		this.#queuePushes++;
		this.#queueMaximumDepth = Math.max(this.#queueMaximumDepth, depth);
	}

	recordQueuePop(): void {
		if (!this.collectsCounters) return;
		this.#queuePops++;
	}

	recordBudget(workItems: number, edits: number): void {
		if (!this.collectsCounters) return;
		this.#budgetWorkItems += workItems;
		this.#budgetEdits += edits;
	}

	recordBudgetExhaustion(pass: string): void {
		this.#exhaustedPasses?.add(pass);
	}

	recordCandidateDiscovery(
		candidates: ReadonlyArray<{
			readonly kind: string;
			readonly fanOut: number;
		}>,
	): void {
		if (!this.collectsCounters) return;
		this.increment("specializationCandidatesDiscovered", candidates.length);
		for (const candidate of candidates) {
			this.#discoveredCandidatesByKind?.set(
				candidate.kind,
				(this.#discoveredCandidatesByKind.get(candidate.kind) ?? 0) + 1,
			);
			switch (candidate.kind) {
				case "stack-object":
					this.#discoveredStackObjects++;
					break;
				case "dense-array":
					this.#discoveredDenseArrays++;
					break;
				case "numeric-fusion":
					this.#discoveredNumericFusions++;
					break;
				case "string-split-projection":
				case "string-slice-number":
				case "regexp-exec-projection":
				case "regexp-iterator-projection":
					break;
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
			readonly exactCallEdges: number;
			readonly wildcardCallSites: number;
			readonly wildcardCallers: number;
			readonly opaqueCallSites: number;
			readonly aggregateDependencies: number;
			readonly storedGraphRows: number;
		},
		summaries: {
			readonly sccs: number;
			readonly sccTransfers: number;
			readonly sccEdgeVisits: number;
			readonly summaryChanges: number;
			readonly callerWakeups: number;
			readonly affectedCallers: number;
		},
		reachability: { readonly deadFunctions: number },
	): void {
		if (!this.collectsCounters) return;
		this.increment("functionScans", callGraph.functionsAnalyzed);
		this.increment("explicitCallEdges", callGraph.exactCallEdges);
		this.increment("wildcardCallSources", callGraph.wildcardCallers);
		this.increment("wildcardCallSites", callGraph.wildcardCallSites);
		this.increment("opaqueCallSites", callGraph.opaqueCallSites);
		this.increment("aggregateDependencies", callGraph.aggregateDependencies);
		this.increment("storedCallGraphRows", callGraph.storedGraphRows);
		this.increment("sccNodes", callGraph.functionsAnalyzed);
		this.increment("sccEdges", summaries.sccEdgeVisits);
		this.increment("sccTransfers", summaries.sccTransfers);
		this.#programWork = Object.freeze({
			functionsAnalyzed: callGraph.functionsAnalyzed,
			functionsReused: callGraph.functionsReused,
			callSites: callGraph.callSites,
			exactCallEdges: callGraph.exactCallEdges,
			wildcardCallers: callGraph.wildcardCallers,
			wildcardCallSites: callGraph.wildcardCallSites,
			opaqueCallSites: callGraph.opaqueCallSites,
			aggregateDependencies: callGraph.aggregateDependencies,
			storedGraphRows: callGraph.storedGraphRows,
			sccs: summaries.sccs,
			sccTransfers: summaries.sccTransfers,
			summaryChanges: summaries.summaryChanges,
			callerWakeups: summaries.callerWakeups,
			affectedCallers: summaries.affectedCallers,
			deadFunctions: reachability.deadFunctions,
		});
	}

	recordTransformWork(report: CoreTransformWorkReport): void {
		if (!this.collectsCounters) return;
		this.increment("functionScans", report.callGraphFunctionsAnalyzed);
		this.increment("sccTransfers", report.sccTransfers);
		this.increment(
			"wildcardAggregateRecomputations",
			report.wildcardAggregateRecomputations,
		);
		this.increment("exactReverseCallerVisits", report.exactReverseCallerVisits);
		this.increment("wildcardReverseCallerVisits", report.wildcardReverseCallerVisits);
		this.#transformWork = this.collectsDetails
			? Object.freeze({ ...report })
			: Object.freeze({
					...report,
					appliedByKind: Object.freeze({}),
					declinedByReason: Object.freeze({}),
				});
	}

	recordPlanWork(report: CoreOptimizationPlanStatistics): void {
		if (!this.collectsCounters) return;
		this.increment("specializationCandidatesSelected", report.applied);
		this.#planWork = Object.freeze({
			discovered: Object.values(report.discoveredByKind).reduce(
				(sum, count) => sum + count,
				0,
			),
			selected: report.applied,
			declined: report.declined,
			discoveredByKind: this.collectsDetails
				? Object.freeze({ ...report.discoveredByKind })
				: Object.freeze({}),
			selectedByKind: this.collectsDetails
				? Object.freeze({ ...report.selectedByKind })
				: Object.freeze({}),
			declinedByReason: this.collectsDetails
				? Object.freeze({
						...report.declinedByReason,
						...report.declinedByPlanReason,
					})
				: Object.freeze({}),
			generatedCodeConsumed: report.generatedCodeConsumed,
			compilerWorkConsumed: report.compilerWorkConsumed,
			verificationMs: report.verificationMs,
		});
	}

	#recordStorageWork(program: CoreProgram): void {
		if (!this.collectsCounters) return;
		let liveUses = 0;
		let deadUses = 0;
		let abandonedOperands = 0;
		let abandonedParameters = 0;
		for (const functionId of program.functionIds()) {
			const fn = program.function(functionId);
			let liveOperands = 0;
			for (let instruction = 0; instruction < fn.instructionCapacity; instruction++) {
				const layout = fn.instructionLayout(instruction);
				if (layout.live) liveOperands += layout.operandCount;
			}
			let liveParameters = 0;
			for (let block = 0; block < fn.blockCapacity; block++) {
				const layout = fn.blockLayout(block);
				if (layout.live) liveParameters += layout.parameterCount;
			}
			for (let use = 0; use < fn.useCapacity; use++) {
				if (fn.useLayout(use).live) liveUses++;
				else deadUses++;
			}
			abandonedOperands += fn.operandCapacity - liveOperands;
			abandonedParameters += fn.blockParameterCapacity - liveParameters;
		}
		this.increment("liveUseVisits", liveUses);
		this.increment("deadUseSkips", deadUses);
		this.increment("abandonedOperandStorage", abandonedOperands);
		this.increment("abandonedParameterStorage", abandonedParameters);
	}

	finish(
		program: CoreProgram,
		plan: Pick<CoreOptimizationPlan, "directEntries" | "specializations">,
	): CoreOptimizationReport {
		this.#recordStorageWork(program);
		const passes = this.#passes;
		const analyses = this.#analyses;
		const discoveredCandidatesByKind = this.#discoveredCandidatesByKind;
		const counters = Object.freeze(
			Object.fromEntries(
				COUNTER_KEYS.map((key, index) => [key, this.#counters[index]]),
			) as unknown as CoreCompilerWorkCounters,
		);
		return Object.freeze({
			instrumentation: this.instrumentation,
			input: this.input,
			output:
				this.instrumentation === "off"
					? EMPTY_COUNTS
					: Object.freeze(coreOptimizationCounts(program, plan)),
			stages: Object.freeze([...this.#stages]),
			passes: Object.freeze(
				[...(passes?.entries() ?? [])].map(([pass, report]) =>
					Object.freeze({ pass, ...report }),
				),
			),
			analyses: Object.freeze(
				[...(analyses?.entries() ?? [])].map(([analysis, report]) =>
					Object.freeze({ analysis, ...report }),
				),
			),
			discovery: Object.freeze({
				candidates: [...(discoveredCandidatesByKind?.values() ?? [])].reduce(
					(total, count) => total + count,
					0,
				),
				byKind: Object.freeze(Object.fromEntries(discoveredCandidatesByKind ?? [])),
				stackObjects: this.#discoveredStackObjects,
				denseArrays: this.#discoveredDenseArrays,
				numericFusions: this.#discoveredNumericFusions,
				largestFanOut: this.#largestCandidateFanOut,
			}),
			program: this.#programWork,
			transforms: this.#transformWork,
			plan: this.#planWork,
			queue: Object.freeze({
				pushes: this.#queuePushes,
				pops: this.#queuePops,
				maximumDepth: this.#queueMaximumDepth,
			}),
			budget: Object.freeze({
				workItems: this.#budgetWorkItems,
				edits: this.#budgetEdits,
				exhaustedPasses: Object.freeze([...(this.#exhaustedPasses ?? [])]),
			}),
			counters,
		});
	}
}

function countsLine(counts: CoreOptimizationCounts): string {
	return `${counts.functions} functions, ${counts.blocks} blocks, ${counts.instructions} instructions, ${counts.values} values, ${counts.facts} facts, ${counts.planCandidates} candidates`;
}

export function formatCoreOptimizationReport(
	report: CoreOptimizationReport,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
	const passes =
		report.passes.length === 0
			? "none"
			: report.passes
					.map(
						(pass) =>
							`${pass.pass} ${pass.runs} runs/${pass.workItems} work/${pass.changedItems} changed/${pass.edits} edits/${pass.elapsedMs.toFixed(1)}ms`,
					)
					.join("; ");
	const analyses =
		report.analyses.length === 0
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
			value: `${report.program.functionsAnalyzed} functions analyzed/${report.program.functionsReused} reused, ${report.program.callSites} callsites/${report.program.exactCallEdges} exact edges/${report.program.wildcardCallers} wildcard callers/${report.program.opaqueCallSites} opaque sites, ${report.program.sccs} SCCs/${report.program.sccTransfers} transfers, ${report.program.summaryChanges} summary changes/${report.program.callerWakeups} caller wakeups/${report.program.affectedCallers} callers, ${report.program.deadFunctions} dead omitted`,
		},
		{
			label: "Core optimizer transforms",
			value: `${report.transforms.considered} considered/${report.transforms.applied} applied/${report.transforms.declined} declined; applied ${
				Object.entries(report.transforms.appliedByKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}; declined ${
				Object.entries(report.transforms.declinedByReason)
					.filter(([, count]) => count > 0)
					.map(([reason, count]) => `${reason}=${count}`)
					.join(", ") || "none"
			}; generated ${report.transforms.generatedCodeConsumed}, compiler work ${report.transforms.compilerWorkConsumed}, introduced ${report.transforms.instructionsIntroduced} instructions/${report.transforms.blocksIntroduced} blocks, callgraph analyzed ${report.transforms.callGraphFunctionsAnalyzed}, SCC transfers ${report.transforms.sccTransfers}, caller wakeups ${report.transforms.callerWakeups}, value kinds evaluated ${report.transforms.valueKindFunctionEvaluations}/folded ${report.transforms.valueKindFolds}`,
		},
		{
			label: "Core optimizer discovery",
			value: `${report.discovery.candidates} candidates (${
				Object.entries(report.discovery.byKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}), largest fan-out ${report.discovery.largestFanOut}`,
		},
		{
			label: "Core optimizer specialization plan",
			value: `${report.plan.discovered} discovered/${report.plan.selected} selected/${report.plan.declined} declined; discovered ${
				Object.entries(report.plan.discoveredByKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}; selected ${
				Object.entries(report.plan.selectedByKind)
					.filter(([, count]) => count > 0)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(", ") || "none"
			}; declined ${
				Object.entries(report.plan.declinedByReason)
					.filter(([, count]) => count > 0)
					.map(([reason, count]) => `${reason}=${count}`)
					.join(", ") || "none"
			}; generated ${report.plan.generatedCodeConsumed}, compiler work ${report.plan.compilerWorkConsumed}, verified ${report.plan.verificationMs.toFixed(1)}ms`,
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
