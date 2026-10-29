import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import type { CoreDirectEntryPlan } from "../src/compiler/core/core-ir-regions.ts";
import {
	analyzeCoreNativeEntry,
	compactCoreNativeEntries,
	coreNativeEntryProofIsCurrent,
} from "../src/compiler/core/core-native-entry-analysis.ts";
import { connectCoreNativeEntries } from "../src/compiler/core/core-native-entry-graph.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	CoreTransformCandidateService,
	DEFAULT_CORE_TRANSFORM_BUDGETS,
} from "../src/compiler/core/core-transform-candidates.ts";
import type { CoreTransformCandidate } from "../src/compiler/core/core-transform-candidates.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

function refinedGraph(
	numeric: boolean,
	sharedTarget: boolean,
	recursive = false,
	seedDead = false,
) {
	const program = analysisProgram();
	const builders = Array.from(
		{ length: recursive ? 5 : 4 },
		() =>
			new CoreFunctionBuilder(program, { parameterCount: 1, metadata: { strict: true } }),
	);
	const [caller, producer, dead, live] = builders;
	const source = producer!.createBlock([{}]);
	const [converted] = producer!.appendInstruction(
		source,
		"unary",
		[producer!.blockParameterValue(source, 0)],
		{ attributes: { operator: numeric ? "+" : "!" } },
	);
	producer!.setTerminator(source, { kind: "return", value: converted! });
	producer!.finish(source);
	for (const index of recursive ? [2, 4] : [2]) {
		const fn = builders[index]!,
			block = fn.createBlock([{}]);
		let result = fn.blockParameterValue(block, 0);
		if (recursive) {
			const [target] = fn.appendInstruction(block, "createFunction", [], {
				attributes: { functionIndex: builders[index === 2 ? 4 : 2]!.functionId },
			});
			const [receiver] = fn.appendInstruction(block, "createUndefined", []);
			[result] = fn.appendInstruction(block, "call", [target!, receiver!, result]) as [
				typeof result,
			];
		}
		fn.setTerminator(block, { kind: "return", value: result });
		fn.finish(block);
	}
	const identity = live!.createBlock([{}]);
	live!.setTerminator(identity, {
		kind: "return",
		value: live!.blockParameterValue(identity, 0),
	});
	live!.finish(identity);
	const entry = caller!.createBlock([{}]),
		yes = caller!.createBlock(),
		no = caller!.createBlock();
	const parameter = caller!.blockParameterValue(entry, 0);
	const [sourceTarget] = caller!.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: producer!.functionId },
	});
	const [receiver] = caller!.appendInstruction(entry, "createUndefined", []);
	const [value] = caller!.appendInstruction(entry, "call", [
		sourceTarget!,
		receiver!,
		parameter,
	]);
	const [condition] = caller!.appendInstruction(entry, "binary", [value!, value!], {
		attributes: { operator: "===" },
	});
	caller!.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: yes, arguments: [] },
		alternate: { block: no, arguments: [] },
	});
	const [deadTarget] = caller!.appendInstruction(no, "createFunction", [], {
		attributes: { functionIndex: dead!.functionId },
	});
	const [deadResult] = caller!.appendInstruction(no, "call", [
		deadTarget!,
		receiver!,
		parameter,
	]);
	const deadCall = caller!.bodyInstructionIds(no).at(-1)!;
	caller!.setTerminator(no, { kind: "return", value: deadResult! });
	const [liveTarget] = caller!.appendInstruction(yes, "createFunction", [], {
		attributes: { functionIndex: (sharedTarget ? dead : live)!.functionId },
	});
	const [liveResult] = caller!.appendInstruction(yes, "call", [
		liveTarget!,
		receiver!,
		value!,
	]);
	const liveCall = caller!.bodyInstructionIds(yes).at(-1)!;
	caller!.setTerminator(yes, { kind: "return", value: liveResult! });
	caller!.finish(entry);
	const analyses = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	const seed: CoreDirectEntryPlan = {
		id: 0,
		function: caller!.functionId,
		callSites: [],
		parameterRepresentations: ["f64"],
		...analyzeCoreNativeEntry(
			program,
			buildCoreControlFlow(program, caller!.functionId),
			["f64"],
			undefined,
			[],
		),
		target: "native",
		fallback: "canonical-core",
		cost: { generatedCode: 8, compilerWork: 8, runtimeBenefit: 8 },
	};
	const seeds = [seed];
	if (seedDead)
		seeds.push({
			...seed,
			function: dead!.functionId,
			...analyzeCoreNativeEntry(
				program,
				buildCoreControlFlow(program, dead!.functionId),
				["f64"],
				undefined,
				[],
			),
		});
	const { entries, retiredEntries } = connectCoreNativeEntries(
		program,
		summaries,
		analyses,
		new Set(program.functionIds()),
		seeds,
		() => true,
		() => true,
	);
	return { program, builders, entries, retiredEntries, seed, deadCall, liveCall };
}

describe("retained native entry graph", () => {
	it("retires a nomination made before its caller gains a scalar result fact", () => {
		const graph = refinedGraph(false, false),
			caller = graph.entries.find((e) => e.function === graph.builders[0]!.functionId)!;
		expect(caller.callOverrides?.some((c) => c.instruction === graph.deadCall)).toBe(
			false,
		);
		expect(caller.callOverrides?.some((c) => c.instruction === graph.liveCall)).toBe(
			true,
		);
		expect(graph.entries.some((e) => e.function === graph.builders[2]!.functionId)).toBe(
			false,
		);
		expect(
			graph.program
				.function(graph.builders[0]!.functionId)
				.isInstructionLive(graph.deadCall),
		).toBe(true);
		expect(caller.resultRepresentation).toBe("boolean");
	});
	it("keeps the Number self-comparison fallback that NaN can take", () => {
		const graph = refinedGraph(true, false),
			caller = graph.entries.find((e) => e.function === graph.builders[0]!.functionId)!;
		expect(caller.callOverrides?.some((c) => c.instruction === graph.deadCall)).toBe(
			true,
		);
		expect(graph.entries.some((e) => e.function === graph.builders[2]!.functionId)).toBe(
			true,
		);
	});
	it("compacts surviving sibling IDs without changing their signatures or proofs", () => {
		const graph = refinedGraph(false, true),
			retained = graph.entries.filter(
				(e) => e.function === graph.builders[2]!.functionId,
			);
		expect(retained).toHaveLength(1);
		expect(retained[0]).toMatchObject({
			id: 0,
			parameterRepresentations: ["boolean"],
			resultRepresentation: "boolean",
		});
		for (const entry of graph.entries) {
			expect(
				coreNativeEntryProofIsCurrent(graph.program.function(entry.function), entry),
			).toBe(true);
			for (const call of entry.callOverrides ?? [])
				expect(
					graph.entries.some((e) => e.function === call.target && e.id === call.entryId),
				).toBe(true);
		}
		expect(
			coreNativeEntryProofIsCurrent(
				graph.program.function(graph.seed.function),
				graph.seed,
			),
		).toBe(true);
	});
	it("drops an unrooted recursive component reached only by a retired nomination", () => {
		const graph = refinedGraph(false, false, true);
		expect(
			graph.entries.some(
				(e) =>
					e.function === graph.builders[2]!.functionId ||
					e.function === graph.builders[4]!.functionId,
			),
		).toBe(false);
	});
	it("retains independently seeded entries when their graph nomination disappears", () => {
		const graph = refinedGraph(false, false, false, true);
		expect(graph.entries.some((e) => e.function === graph.builders[2]!.functionId)).toBe(
			true,
		);
		expect(
			graph.retiredEntries.some((e) => e.function === graph.builders[2]!.functionId),
		).toBe(false);
	});
	it("rejects dropping a live target or rebinding an unproven entry", () => {
		const graph = refinedGraph(false, true);
		expect(() =>
			compactCoreNativeEntries(
				graph.program,
				graph.entries.filter((e) => e.function !== graph.builders[1]!.functionId),
			),
		).toThrow(/Dangling/);
		const entry = graph.entries[0]!;
		expect(() =>
			compactCoreNativeEntries(graph.program, [
				{ ...entry, valueRepresentations: [...entry.valueRepresentations!] },
			]),
		).toThrow(/unproven/);
	});
	it("releases retired code capacity while retaining proof-work consumption", () => {
		const graph = refinedGraph(false, false);
		const service = new CoreTransformCandidateService({
			...DEFAULT_CORE_TRANSFORM_BUDGETS,
			perCallerGeneratedCode: 8,
			programGeneratedCode: 8,
			perCallerCompilerWork: 5,
			programCompilerWork: 5,
		});
		const candidate: CoreTransformCandidate = {
			kind: "direct-entry",
			caller: graph.builders[0]!.functionId,
			site: graph.deadCall,
			revision: 0,
			priorityClass: 0,
			priorityScore: 0,
			targets: [graph.builders[2]!.functionId],
			generatedCodeCost: 8,
			compilerWorkCost: 5,
			expansive: false,
		};
		service.consider(candidate);
		expect(service.admit(candidate)).toBeUndefined();
		service.recordApplied(candidate);
		expect(service.admit({ ...candidate, revision: 1 })).toBe("generated-code-cost");
		expect(service.recordRetiredEntry(candidate)).toBe(5);
		expect(service.statistics()).toMatchObject({
			applied: 0,
			declined: 1,
			generatedCodeConsumed: 0,
			compilerWorkConsumed: 5,
			declinedByReason: { "unreferenced-entry": 1 },
		});
		expect(
			service.admit({ ...candidate, revision: 1, compilerWorkCost: 0 }),
		).toBeUndefined();
		expect(service.admit({ ...candidate, revision: 1 })).toBe("compiler-work-cost");
		expect(() => service.recordRetiredEntry(candidate)).toThrow();
	});
	it("retains the semantic result fact that keeps an unseeded loop dead", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program, {
				parameterCount: 1,
				metadata: { strict: true },
			}),
			callee = new CoreFunctionBuilder(program, {
				parameterCount: 1,
				metadata: { strict: true },
			});
		const leaf = callee.createBlock([{}]);
		const [flag] = callee.appendInstruction(
			leaf,
			"unary",
			[callee.blockParameterValue(leaf, 0)],
			{ attributes: { operator: "!" } },
		);
		callee.setTerminator(leaf, { kind: "return", value: flag! });
		callee.finish(leaf);
		const start = caller.createBlock([{}]),
			header = caller.createBlock([{}]),
			body = caller.createBlock(),
			done = caller.createBlock();
		const [initial] = caller.appendInstruction(start, "createBoolean", [], {
			attributes: { value: false },
		});
		caller.setTerminator(start, {
			kind: "jump",
			edge: { block: header, arguments: [initial!] },
		});
		const value = caller.blockParameterValue(header, 0);
		const [condition] = caller.appendInstruction(header, "binary", [value, value], {
			attributes: { operator: "!==" },
		});
		caller.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: done, arguments: [] },
		});
		const [target] = caller.appendInstruction(body, "createFunction", [], {
			attributes: { functionIndex: callee.functionId },
		});
		const [receiver] = caller.appendInstruction(body, "createUndefined", []);
		const [next] = caller.appendInstruction(body, "call", [
			target!,
			receiver!,
			caller.blockParameterValue(start, 0),
		]);
		caller.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [next!] },
		});
		caller.setTerminator(done, { kind: "return", value });
		caller.finish(start);
		const analyses = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const seed: CoreDirectEntryPlan = {
			id: 0,
			function: caller.functionId,
			callSites: [],
			parameterRepresentations: ["f64"],
			...analyzeCoreNativeEntry(
				program,
				buildCoreControlFlow(program, caller.functionId),
				["f64"],
				undefined,
				[],
			),
			target: "native",
			fallback: "canonical-core",
			cost: { generatedCode: 8, compilerWork: 8, runtimeBenefit: 8 },
		};
		const result = connectCoreNativeEntries(
			program,
			analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" }),
			analyses,
			new Set(program.functionIds()),
			[seed],
			() => true,
			() => true,
		);
		expect(result.entries).toHaveLength(1);
		expect(result.retiredEntries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({
			resultRepresentation: "boolean",
			callOverrides: [],
		});
		expect(
			coreNativeEntryProofIsCurrent(
				program.function(caller.functionId),
				result.entries[0]!,
			),
		).toBe(true);
	});
});
