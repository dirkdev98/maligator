import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import type {
	CoreDirectEntryPlan,
	CorePlanRepresentation,
} from "../src/compiler/core/core-ir-regions.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";
import {
	analyzeCoreNativeEntry,
	coreNativeEntryProofIsCurrent,
} from "../src/compiler/core/core-native-entry-analysis.ts";
import { connectCoreNativeEntries } from "../src/compiler/core/core-native-entry-graph.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

type ResultKind = "number" | "boolean" | "string" | "boxed" | "constant";

function resultGraph(
	kind: ResultKind,
	options: { allowEntries?: boolean; allowResultAnalysis?: boolean } = {},
) {
	const program = analysisProgram();
	const caller = new CoreFunctionBuilder(program, {
		parameterCount: 2,
		metadata: { strict: true },
	});
	const leaf = new CoreFunctionBuilder(program, {
		parameterCount: kind === "constant" ? 0 : 1,
		metadata: { strict: true },
	});
	const leafBody = leaf.createBlock(kind === "constant" ? [] : [{}]);
	let leafResult;
	if (kind === "constant") {
		[leafResult] = leaf.appendInstruction(leafBody, "createNumber", [], {
			attributes: { value: 7 },
		});
	} else {
		const value = leaf.blockParameterValue(leafBody, 0);
		if (kind === "boxed") leafResult = value;
		else {
			[leafResult] = leaf.appendInstruction(leafBody, "unary", [value], {
				attributes: {
					operator: kind === "number" ? "+" : kind === "boolean" ? "!" : "typeof",
				},
			});
		}
	}
	if (leafResult === undefined) throw new Error("Missing leaf result");
	leaf.setTerminator(leafBody, { kind: "return", value: leafResult });
	leaf.finish(leafBody);

	const body = caller.createBlock([{}, {}]);
	const [callee] = caller.appendInstruction(body, "createFunction", [], {
		attributes: { functionIndex: leaf.functionId },
	});
	const [receiver] = caller.appendInstruction(body, "createUndefined", []);
	const [result] = caller.appendInstruction(body, "call", [
		callee!,
		receiver!,
		...(kind === "constant" ? [] : [caller.blockParameterValue(body, 1)]),
	]);
	if (result === undefined) throw new Error("Missing caller result");
	caller.setTerminator(body, { kind: "return", value: result });
	caller.finish(body);

	const analyses = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	const parameters: ReadonlyArray<CorePlanRepresentation> = ["f64", "boxed"];
	const initial: CoreDirectEntryPlan = {
		id: 0,
		function: caller.functionId,
		parameterRepresentations: parameters,
		callSites: [],
		...analyzeCoreNativeEntry(
			program.function(caller.functionId),
			buildCoreControlFlow(program, caller.functionId),
			parameters,
			undefined,
			[],
		),
		target: "native",
		fallback: "canonical-core",
		cost: { generatedCode: 8, compilerWork: 8, runtimeBenefit: 8 },
	};
	const admissions: Array<{ target: CoreFunctionId; code: number; work: number }> = [];
	const discoveries: Array<{ target: CoreFunctionId; work: number }> = [];
	const entries = connectCoreNativeEntries(
		program,
		summaries,
		analyses,
		new Set(program.functionIds()),
		[initial],
		[],
		(target, _instruction, code, work) => {
			admissions.push({ target, code, work });
			return options.allowEntries !== false;
		},
		(target, work) => {
			discoveries.push({ target, work });
			return target !== leaf.functionId || options.allowResultAnalysis !== false;
		},
	);
	return { program, caller, leaf, initial, entries, admissions, discoveries };
}

describe("native result-only contracts", () => {
	it.each([
		["number", "f64"],
		["boolean", "boolean"],
		["string", "string"],
		["constant", "f64"],
	] as const)("connects a proved %s result without scalar arguments", (kind, result) => {
		const graph = resultGraph(kind);
		expect(graph.entries).toHaveLength(2);
		const leaf = graph.entries.find((entry) => entry.function === graph.leaf.functionId)!;
		const caller = graph.entries.find(
			(entry) => entry.function === graph.caller.functionId,
		)!;
		expect(leaf.parameterRepresentations).toEqual(kind === "constant" ? [] : ["boxed"]);
		expect(leaf.resultRepresentation).toBe(result);
		expect(caller.resultRepresentation).toBe(result);
		expect(caller.callOverrides).toEqual([
			expect.objectContaining({ target: leaf.function, entryId: leaf.id }),
		]);
		expect(graph.initial.resultRepresentation).toBe("boxed");
		expect(graph.initial.callOverrides).toBeUndefined();
		for (const entry of graph.entries) {
			const fn = graph.program.function(entry.function);
			expect(coreNativeEntryProofIsCurrent(fn, entry)).toBe(true);
		}
		const fn = graph.program.function(leaf.function);
		const code = Math.max(8, [...fn.instructionIds()].length);
		expect(graph.admissions).toEqual([{ target: leaf.function, code, work: 0 }]);
		expect(graph.discoveries).toContainEqual({
			target: leaf.function,
			work: code + fn.valueCapacity,
		});
	});

	it("does not spend a generated sibling on a still-boxed return", () => {
		const graph = resultGraph("boxed");
		expect(graph.entries).toEqual([graph.initial]);
		expect(graph.admissions).toEqual([]);
	});

	it("keeps a proved result generic when its generated-code budget is denied", () => {
		const graph = resultGraph("number", { allowEntries: false });
		expect(graph.entries).toEqual([graph.initial]);
		expect(graph.admissions).toHaveLength(1);
	});

	it("does not create a result proof when its analysis budget is denied", () => {
		const graph = resultGraph("number", { allowResultAnalysis: false });
		expect(graph.entries).toEqual([graph.initial]);
		expect(graph.admissions).toEqual([]);
	});
});
