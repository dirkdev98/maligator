import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { COMPILER_VALUE_KIND_OBJECT } from "../src/compiler/shared/compiler-value-kinds.ts";
import { EVERY_EFFECT_SUMMARY } from "../src/compiler/shared/effect-summary.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

describe("incremental Core program summaries", () => {
	it.each([false, true])(
		"carries receiver normalization into caller conditions (strict=%s)",
		(strict) => {
			const program = analysisProgram();
			const leaf = new CoreFunctionBuilder(program, {
				metadata: { strict, sourcePath: "/entry.js" },
			});
			const leafEntry = leaf.createBlock();
			const [receiver] = leaf.appendInstruction(leafEntry, "loadThis", []);
			leaf.setTerminator(leafEntry, { kind: "return", value: receiver! });
			const leafId = leaf.finish(leafEntry).function;
			const caller = new CoreFunctionBuilder(program, {
				parameterCount: 1,
				metadata: { strict: true, sourcePath: "/entry.js" },
			});
			const entry = caller.createBlock([{}]);
			const [callee] = caller.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: leafId },
			});
			const [result] = caller.appendInstruction(entry, "call", [
				callee!,
				caller.blockParameterValue(entry, 0),
			]);
			caller.setTerminator(entry, { kind: "return", value: result! });
			const callerId = caller.finish(entry).function;
			const manager = new CoreAnalysisManager(
				program,
				programAnalysisContext(),
				new CoreOptimizationReportBuilder(program),
			);
			const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
				scope: "program",
			});
			expect(summaries.summary(callerId)?.returnProvenance).toEqual({
				kind: "parameter",
				index: 0,
				...(strict ? {} : { identityKinds: COMPILER_VALUE_KIND_OBJECT }),
			});
		},
	);

	it.each([false, true])(
		"requires a grounded normal return in recursive projections (grounded=%s)",
		(grounded) => {
			const program = analysisProgram();
			const builder = new CoreFunctionBuilder(program, {
				parameterCount: 2,
				metadata: { strict: true, sourcePath: "/entry.js" },
			});
			const entry = builder.createBlock([{}, {}]);
			const recursive = builder.createBlock();
			const value = builder.blockParameterValue(entry, 0);
			const flag = builder.blockParameterValue(entry, 1);
			if (grounded) {
				const base = builder.createBlock();
				builder.setTerminator(entry, {
					kind: "branch",
					condition: flag,
					consequent: { block: base, arguments: [] },
					alternate: { block: recursive, arguments: [] },
				});
				const [receiver] = builder.appendInstruction(base, "createUndefined", []);
				const [result] = builder.appendInstruction(
					base,
					"callKnown",
					[receiver!, value],
					{
						attributes: { operation: "Object.assign" },
					},
				);
				builder.setTerminator(base, { kind: "return", value: result! });
			} else
				builder.setTerminator(entry, {
					kind: "jump",
					edge: { block: recursive, arguments: [] },
				});
			const [callee] = builder.appendInstruction(recursive, "createFunction", [], {
				attributes: { functionIndex: 0 },
			});
			const [receiver] = builder.appendInstruction(recursive, "createUndefined", []);
			const [result] = builder.appendInstruction(recursive, "call", [
				callee!,
				receiver!,
				value,
				flag,
			]);
			builder.setTerminator(recursive, { kind: "return", value: result! });
			const functionId = builder.finish(entry).function;
			const manager = new CoreAnalysisManager(
				program,
				programAnalysisContext(),
				new CoreOptimizationReportBuilder(program),
			);
			const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
				scope: "program",
			});
			expect(summaries.summary(functionId)?.returnProvenance).toEqual(
				grounded
					? { kind: "parameter", index: 0, identityKinds: COMPILER_VALUE_KIND_OBJECT }
					: { kind: "none" },
			);
		},
	);

	it("projects conditional returns through call chains and withdraws them after callee edits", () => {
		const program = analysisProgram();
		const leaf = new CoreFunctionBuilder(program, {
			parameterCount: 1,
			metadata: { strict: true, sourcePath: "/entry.js" },
		});
		const leafEntry = leaf.createBlock([{}]);
		const [receiver] = leaf.appendInstruction(leafEntry, "createUndefined", []);
		const [result] = leaf.appendInstruction(
			leafEntry,
			"callKnown",
			[receiver!, leaf.blockParameterValue(leafEntry, 0)],
			{ attributes: { operation: "Object.assign" } },
		);
		leaf.setTerminator(leafEntry, { kind: "return", value: result! });
		const leafId = leaf.finish(leafEntry).function;
		let target = leafId;
		for (let index = 0; index < 3; index++) {
			const builder = new CoreFunctionBuilder(program, {
				parameterCount: 1,
				metadata: { strict: true, sourcePath: "/entry.js" },
			});
			const entry = builder.createBlock([{}]);
			const [callee] = builder.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: target },
			});
			const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
			const [result] = builder.appendInstruction(entry, "call", [
				callee!,
				receiver!,
				builder.blockParameterValue(entry, 0),
			]);
			builder.setTerminator(entry, { kind: "return", value: result! });
			target = builder.finish(entry).function;
		}
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
		expect(first.summary(target)?.returnProvenance).toEqual({
			kind: "parameter",
			index: 0,
			identityKinds: COMPILER_VALUE_KIND_OBJECT,
		});
		expect(first.summary(target)?.effects.mayThrow).toBe(true);
		expect(first.summary(target)?.effects.callsUserCode).toBe(true);
		const editor = CoreEditor.open(program, leafId);
		const replacement = editor.appendInstruction(leafEntry, "createObject", []);
		editor.replaceTerminator(leafEntry, {
			kind: "return",
			value: replacement.outputs[0]!,
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
		expect(second.summary(target)?.returnProvenance).toEqual({ kind: "fresh" });
	});

	it.each(["caught", "carried"] as const)(
		"tracks %s values returned from an exception handler",
		(kind) => {
			const program = analysisProgram();
			const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
			const entry = builder.createBlock([{}, {}]);
			const parameter = builder.blockParameterValue(entry, 0);
			const callee = builder.blockParameterValue(entry, 1);
			const handler = builder.createBlock([{ role: "exception" }, {}]);
			builder.appendInstruction(entry, "call", [callee, parameter]);
			builder.setHandler(entry, handler, [parameter]);
			builder.setTerminator(
				entry,
				kind === "caught"
					? { kind: "return", value: parameter }
					: { kind: "throw", value: callee },
			);
			builder.setTerminator(handler, {
				kind: "return",
				value: builder.blockParameterValue(handler, kind === "caught" ? 0 : 1),
			});
			const functionId = builder.finish(entry).function;
			const manager = new CoreAnalysisManager(
				program,
				programAnalysisContext(),
				new CoreOptimizationReportBuilder(program),
			);
			const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
				scope: "program",
			});
			expect(summaries.summary(functionId)?.returnProvenance).toEqual(
				kind === "caught" ? { kind: "unknown" } : { kind: "parameter", index: 0 },
			);
		},
	);

	it("retains later callee escapes and module members after effects reach top", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program, {
			parameterCount: 2,
			metadata: { strict: true, sourcePath: "/entry.js" },
		});
		const entry = caller.createBlock([{}, {}]);
		const opaque = caller.blockParameterValue(entry, 0);
		const argument = caller.blockParameterValue(entry, 1);
		const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
		caller.appendInstruction(entry, "call", [opaque, receiver!]);
		const [callee] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [result] = caller.appendInstruction(entry, "call", [
			callee!,
			receiver!,
			argument,
		]);
		caller.setTerminator(entry, { kind: "return", value: result! });
		const callerId = caller.finish(entry).function;

		const retaining = new CoreFunctionBuilder(program, {
			parameterCount: 1,
			metadata: { strict: true, sourcePath: "/entry.js" },
		});
		const retainingEntry = retaining.createBlock([{}]);
		retaining.appendInstruction(
			retainingEntry,
			"storeGlobal",
			[retaining.blockParameterValue(retainingEntry, 0)],
			{ attributes: { index: 0 } },
		);
		const [returned] = retaining.appendInstruction(retainingEntry, "createUndefined", []);
		retaining.setTerminator(retainingEntry, { kind: "return", value: returned! });
		const retainingId = retaining.finish(retainingEntry).function;
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
		const summary = summaries.summary(callerId)!;
		expect(summary.effects).toEqual(EVERY_EFFECT_SUMMARY);
		expect(summary.parameterEscape[1]).toBe("retained");
		expect(summary.parameterContainment[1]).toBe("unknown");
		expect(summaries.moduleEffects.get(summary.module)?.functions).toEqual(
			[summary.id, summaries.summary(retainingId)!.id].sort(),
		);
	});

	it("preserves escape effects for the positional prefix of an iterable call", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program, {
			parameterCount: 3,
			metadata: { strict: true, sourcePath: "/entry.js" },
		});
		const entry = builder.createBlock([{}, {}, {}]);
		const callee = builder.blockParameterValue(entry, 0);
		const prefix = builder.blockParameterValue(entry, 1);
		const iterable = builder.blockParameterValue(entry, 2);
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "callSpreadIterable", [
			callee,
			receiver!,
			iterable,
			prefix,
		]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const functionId = builder.finish(entry).function;
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
		expect(summaries.summary(functionId)?.parameterEscape[1]).toBe("retained");
	});

	it("compares production summaries without serializing them", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-ir-summaries.ts", import.meta.url),
			"utf8",
		);
		const flowSource = readFileSync(
			new URL("../src/compiler/core/core-program-flow-analysis.ts", import.meta.url),
			"utf8",
		);
		const engineSource = readFileSync(
			new URL("../src/compiler/core/core-program-flow.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toMatch(/JSON\.stringify/);
		expect(source).not.toMatch(/versionKey:\s*string|localVersionKey/);
		expect(source).toMatch(/function summariesEqual\(/);
		expect(source).not.toMatch(/CORE_PROGRAM_SUMMARIES_ANALYSIS|programFlow\.refresh/);
		expect(flowSource).toMatch(/programFlow\.refresh/);
		expect(flowSource).toMatch(/epoch\.dirtyFunctionAt/);
		expect(flowSource).toMatch(/programFlow\.solveSummaries\(/);
		expect(engineSource).toMatch(/solveSummaries<.*CoreProgramFlowTargetIndex/s);
		expect(source).toMatch(/new CoreProgramFlowEngine\(program\)\.solveSummaries\(/);
		expect(source).not.toMatch(/solveCoreProgramFlowSccs|\.solveSccs\(|memberQueue/);
		expect(source).not.toMatch(/function callGraphSccs\(/);
		expect(source).not.toMatch(/readonly evaluate|evaluate:\s*\(/);
		expect(source).toMatch(/Uint8Array\.from\(transferKinds\)/);
	});

	it("does not publish or wake a caller when an edited leaf is semantically unchanged", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendCaller(program, 2);
		const leaf = appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const versions = [
			first.version(0 as never),
			first.version(1 as never),
			first.version(2 as never),
		];

		const editor = CoreEditor.open(program, leaf.function);
		editor.replaceInstruction(leaf.valueInstruction, "createUndefined", []);
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 1,
			functionsReused: 2,
			summaryChanges: 0,
			callerWakeups: 0,
			affectedCallers: 0,
		});
		expect([
			second.version(0 as never),
			second.version(1 as never),
			second.version(2 as never),
		]).toEqual(versions);
	});

	it("propagates a changed leaf only through reverse callers", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendCaller(program, 2);
		const leaf = appendLeaf(program);
		appendLeaf(program, "/unrelated.js");
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const unrelatedVersion = first.version(3 as never);

		const editor = CoreEditor.open(program, leaf.function);
		editor.replaceInstruction(leaf.valueInstruction, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(second.statistics.functionsAnalyzed).toBe(1);
		expect(second.statistics.functionsReused).toBe(3);
		expect(second.statistics.summaryChanges).toBe(3);
		expect(second.statistics.affectedCallers).toBe(2);
		expect(second.version(0 as never)).toBe(first.version(0 as never) + 1);
		expect(second.version(1 as never)).toBe(first.version(1 as never) + 1);
		expect(second.version(2 as never)).toBe(first.version(2 as never) + 1);
		expect(second.version(3 as never)).toBe(unrelatedVersion);
	});

	it("rebuilds SCCs only in the weak component touched by a call edit", () => {
		const program = analysisProgram();
		const edited = appendCaller(program, 1);
		appendLeaf(program);
		appendCaller(program, 3);
		appendLeaf(program);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const unrelated = first.sccs.find(({ functions }) => functions.includes(2 as never));

		const editor = CoreEditor.open(program, edited.function);
		editor.replaceInstruction(edited.createFunctionInstruction, "createFunction", [], {
			attributes: { functionIndex: 4 },
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		expect(second.sccs.find(({ functions }) => functions.includes(2 as never))).toBe(
			unrelated,
		);
		expect(second.statistics).toMatchObject({
			sccNodesAnalyzed: 3,
			sccsReused: 2,
		});
	});

	it("skips SCC discovery when an isolated body edit leaves call edges unchanged", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		const leaf = appendLeaf(program);
		appendCaller(program, 3);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		const editor = CoreEditor.open(program, leaf.function);
		editor.replaceInstruction(leaf.valueInstruction, "createNull", []);
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		expect(second.sccs).toBe(first.sccs);
		expect(second.statistics).toMatchObject({
			sccNodesAnalyzed: 0,
			sccsReused: 4,
		});
	});

	it("keeps published summaries cached across a fact-only edit", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		const leaf = appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		const editor = CoreEditor.open(program, leaf.function);
		editor.addFact({
			kind: "diagnostic-only",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "diagnostic-only" },
			obligations: [],
			origin: "test",
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		expect(second).toBe(first);
	});

	it("solves a long chain with bounded SCC transfers", () => {
		const program = analysisProgram();
		const length = 64;
		for (let index = 0; index < length - 1; index++) {
			appendCaller(program, index + 1);
		}
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(summaries.sccs).toHaveLength(length);
		expect(summaries.statistics.sccTransfers).toBeLessThanOrEqual(length * 2);
	});

	it("keeps unrelated SCCs out of an incremental summary wave", () => {
		const program = analysisProgram();
		const chainLength = 24;
		for (let index = 0; index < chainLength - 1; index++) {
			appendCaller(program, index + 1);
		}
		const leaf = appendLeaf(program);
		const unrelated: Array<number> = [];
		for (let index = 0; index < 64; index++) {
			unrelated.push(appendLeaf(program, `/unrelated-${index}.js`).function);
		}
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const unrelatedVersions = unrelated.map((functionId) =>
			first.version(functionId as never),
		);

		const editor = CoreEditor.open(program, leaf.function);
		editor.replaceInstruction(leaf.valueInstruction, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		expect(second.statistics).toMatchObject({
			functionsAnalyzed: 1,
			functionsReused: chainLength + unrelated.length - 1,
			summaryChanges: chainLength,
			affectedCallers: chainLength - 1,
		});
		expect(second.statistics.sccTransfers).toBeLessThanOrEqual(chainLength * 2);
		expect(unrelated.map((functionId) => second.version(functionId as never))).toEqual(
			unrelatedVersions,
		);
	});

	it("condenses a large recursive component into one SCC", () => {
		const program = analysisProgram();
		const length = 24;
		for (let index = 0; index < length; index++) {
			appendCaller(program, (index + 1) % length);
		}
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(summaries.sccs).toHaveLength(1);
		expect(summaries.sccs[0]!.functions).toHaveLength(length);
		expect(summaries.statistics.sccTransfers).toBeLessThanOrEqual(length * 2);
	});

	it("keeps an any-script call edge compact while joining its closed-world effects", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const join = builder.createBlock([{ representation: "boxed" }]);
		let decision = entry;
		for (let functionIndex = 1; functionIndex < 5; functionIndex++) {
			const selected = builder.createBlock();
			const alternate = builder.createBlock();
			const [callee] = builder.appendInstruction(selected, "createFunction", [], {
				attributes: { functionIndex },
			});
			builder.setTerminator(selected, {
				kind: "jump",
				edge: { block: join, arguments: [callee!] },
			});
			builder.setTerminator(decision, {
				kind: "branch",
				condition,
				consequent: { block: selected, arguments: [] },
				alternate: { block: alternate, arguments: [] },
			});
			decision = alternate;
		}
		const [lastCallee] = builder.appendInstruction(decision, "createFunction", [], {
			attributes: { functionIndex: 5 },
		});
		builder.setTerminator(decision, {
			kind: "jump",
			edge: { block: join, arguments: [lastCallee!] },
		});
		const callee = inspectCoreBlockParameters(builder, join)[0]!.value;
		const [receiver] = builder.appendInstruction(join, "createUndefined", []);
		const [result] = builder.appendInstruction(join, "call", [callee, receiver!]);
		builder.setTerminator(join, { kind: "return", value: result! });
		builder.finish(entry);
		const effectfulLeaf = appendLeaf(program);
		for (let index = 1; index < 5; index++) appendLeaf(program);
		const editor = CoreEditor.open(program, effectfulLeaf.function);
		editor.replaceInstruction(effectfulLeaf.valueInstruction, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		editor.commit();

		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const summary = summaries.summary(0 as never);
		expect(summary).toBeDefined();
		const aggregateScc = summaries.sccs.find(({ hasAnyScriptAggregate }) =>
			Boolean(hasAnyScriptAggregate),
		);
		expect(aggregateScc?.functions).toContain(0);
		expect(summary!.callees).toEqual([]);
		expect(summary!.openCallEdge).toBe(true);
		expect(summary!.effects.reads).toContain("global-slot");

		const unchanged = CoreEditor.open(program, effectfulLeaf.function);
		unchanged.replaceInstruction(effectfulLeaf.valueInstruction, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		unchanged.commit();
		const repeated = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(repeated.statistics).toMatchObject({
			sccNodesAnalyzed: 0,
			sccsReused: summaries.sccs.length,
		});
	});

	it("rebuilds the aggregate when wildcard call arity changes", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [condition, firstArgument, secondArgument] = inspectCoreBlockParameters(
			builder,
			entry,
		);
		const join = builder.createBlock([{ representation: "boxed" }]);
		let decision = entry;
		for (let functionIndex = 1; functionIndex < 5; functionIndex++) {
			const selected = builder.createBlock();
			const alternate = builder.createBlock();
			const [callee] = builder.appendInstruction(selected, "createFunction", [], {
				attributes: { functionIndex },
			});
			builder.setTerminator(selected, {
				kind: "jump",
				edge: { block: join, arguments: [callee!] },
			});
			builder.setTerminator(decision, {
				kind: "branch",
				condition: condition!.value,
				consequent: { block: selected, arguments: [] },
				alternate: { block: alternate, arguments: [] },
			});
			decision = alternate;
		}
		const [lastCallee] = builder.appendInstruction(decision, "createFunction", [], {
			attributes: { functionIndex: 5 },
		});
		builder.setTerminator(decision, {
			kind: "jump",
			edge: { block: join, arguments: [lastCallee!] },
		});
		const callee = inspectCoreBlockParameters(builder, join)[0]!.value;
		const [receiver] = builder.appendInstruction(join, "createUndefined", []);
		const [result] = builder.appendInstruction(join, "call", [
			callee,
			receiver!,
			firstArgument!.value,
		]);
		builder.setTerminator(join, { kind: "return", value: result! });
		const caller = builder.finish(entry).function;
		for (let index = 0; index < 5; index++) appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(first.summary(caller)?.parameterEscape).toEqual(["none", "retained", "none"]);
		expect(first.summary(caller)?.parameterContainment).toEqual([
			"preserved",
			"unknown",
			"preserved",
		]);

		const fn = program.function(caller);
		const call = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "call",
		)!;
		const editor = CoreEditor.open(program, caller);
		editor.replaceInstruction(call, "call", [
			callee,
			receiver!,
			firstArgument!.value,
			secondArgument!.value,
		]);
		editor.commit();
		const second = manager.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});

		expect(second.statistics.aggregateRecomputations).toBeGreaterThan(0);
		expect(second.summary(caller)?.parameterEscape).toEqual([
			"none",
			"retained",
			"retained",
		]);
		expect(second.summary(caller)?.parameterContainment).toEqual([
			"preserved",
			"unknown",
			"unknown",
		]);
	});
});
