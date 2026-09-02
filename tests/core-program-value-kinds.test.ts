import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import type { CoreFunctionStore, CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { COMPILER_VALUE_KIND_STRING } from "../src/compiler/shared/compiler-value-kinds.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

const OBSERVATION_OPERATORS = new Set(["typeof", "!", "===", "!=="]);

it("uses program-flow dirtiness without serialized version or target keys", () => {
	const source = readFileSync(
		new URL("../src/compiler/core/core-ir-value-kinds.ts", import.meta.url),
		"utf8",
	);
	const flowSource = readFileSync(
		new URL("../src/compiler/core/core-program-flow-analysis.ts", import.meta.url),
		"utf8",
	);

	expect(source).not.toMatch(
		/versionKeys|programValueKindVersionKey|programValueKindTargetsKey/,
	);
	expect(source).not.toMatch(/singleAssignmentGlobalSlots\.join/);
	expect(source).not.toMatch(/CORE_PROGRAM_VALUE_KIND_ANALYSIS|programFlow\.refresh/);
	expect(flowSource).toMatch(/programFlow\.refresh/);
	expect(flowSource).toMatch(/epoch\.dirtyFunctionAt/);
	expect(source).not.toMatch(
		/interface KindTransfer\s*\{|readonly evaluate|evaluate:\s*\(/,
	);
	expect(source).toMatch(/Uint8Array\.from\(transfers\.kinds\)/);
});

function observations(fn: CoreFunctionStore) {
	return coreOperations(fn).filter(
		({ opcode, attributes }) =>
			opcode === "typeofCompare" ||
			((opcode === "unary" || opcode === "binary") &&
				typeof attributes.operator === "string" &&
				OBSERVATION_OPERATORS.has(attributes.operator)),
	);
}

function compileRecursiveObservation(sourceClosed: boolean): {
	readonly program: CoreProgram;
	readonly valueKindFolds: number;
	readonly waves: number;
	readonly programFlowResolves: number;
	readonly callerEditSessions: number;
	readonly callerLocalOptimizations: number;
} {
	const sourcePath = "core-program-value-kinds.js";
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		`function observe(text, absent, count) {
			if (count > 0) return observe(text, absent, count - 1);
			return typeof text === "string" && text !== 1 && !absent;
		}
		globalThis.result = observe("value", null, globalThis.count);`,
		sourcePath,
	);
	let optimized: CoreProgram | undefined;
	let valueKindFolds = 0;
	let waves = 0;
	let programFlowResolves = 0;
	let callerEditSessions = 0;
	let callerLocalOptimizations = 0;
	compileSemanticProgramToProgramImage(semantic, {
		coreInstrumentation: "counters",
		...(sourceClosed
			? {
					facts: withProgramClosure(
						compilerProgramFactsFromConfig(
							resolveBuildConfig({ engine: { eval: false } }),
						),
						programClosureCertificate(
							{ kind: "whole-program", entry: sourcePath },
							[{ kind: "entry-module", module: sourcePath }],
							[],
						),
					),
				}
			: {}),
		afterCoreOptimization(program, _context, report) {
			optimized = program;
			valueKindFolds = report.transforms.valueKindFolds;
			waves = report.transforms.waves;
			programFlowResolves = report.transforms.programFlowResolves;
			callerEditSessions = report.transforms.callerEditSessions;
			callerLocalOptimizations = report.transforms.callerLocalOptimizations;
		},
	});
	return {
		program: optimized!,
		valueKindFolds,
		waves,
		programFlowResolves,
		callerEditSessions,
		callerLocalOptimizations,
	};
}

describe("whole-program Core value kinds", () => {
	it("propagates closed primitive kinds through a recursive caller SCC", () => {
		const result = compileRecursiveObservation(true);
		const optimized = result.program;
		const observe = coreFunctionNamed(optimized, "observe")!;
		expect(coreOperations(observe).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(observations(observe)).toEqual([]);
		expect(result.valueKindFolds).toBe(3);
		expect(result.callerEditSessions).toBe(result.callerLocalOptimizations);
		expect(result.programFlowResolves).toBe(result.waves + 1);
		expect(
			coreOperations(observe).some(
				({ opcode, attributes }) =>
					opcode === "createBoolean" && attributes.value === true,
			),
		).toBe(true);
	});

	it("keeps parameter observations when open-world callers may add other kinds", () => {
		const { program: optimized, valueKindFolds } = compileRecursiveObservation(false);
		const observe = coreFunctionNamed(optimized, "observe")!;
		expect(observations(observe).length).toBeGreaterThan(0);
		expect(valueKindFolds).toBe(0);
	});

	it("recomputes only the edited call component", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		const edited = appendLeaf(program);
		const unrelated = appendLeaf(program, "/unrelated.js");
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" });
		const unrelatedValues = first.values(unrelated.function);

		const editor = CoreEditor.open(program, edited.function);
		editor.replaceInstruction(edited.valueInstruction, "createBoolean", [], {
			attributes: { value: true },
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" });

		expect(second.statistics).toMatchObject({
			functionsEvaluated: 3,
			functionsReused: 1,
			affectedFunctions: 2,
			callerWakeups: 0,
			calleeWakeups: 1,
		});
		expect(second.values(unrelated.function)).toBe(unrelatedValues);
		expect(second.changedFunctions).toEqual(new Set([caller.function, edited.function]));
	});

	it("solves a long return-kind chain with bounded transfers", () => {
		const program = analysisProgram();
		const length = 64;
		for (let index = 0; index < length - 1; index++) appendCaller(program, index + 1);
		appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const kinds = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" });
		expect(kinds.statistics.functionsEvaluated).toBeLessThanOrEqual(length * 2);
	});

	it("joins any-script arguments and returns once across the closed program", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = caller.createBlock([{ representation: "boxed" }]);
		const condition = inspectCoreBlockParameters(caller, entry)[0]!.value;
		const join = caller.createBlock([{ representation: "boxed" }]);
		let decision = entry;
		for (let functionIndex = 1; functionIndex < 5; functionIndex++) {
			const selected = caller.createBlock();
			const alternate = caller.createBlock();
			const [callee] = caller.appendInstruction(selected, "createFunction", [], {
				attributes: { functionIndex },
			});
			caller.setTerminator(selected, {
				kind: "jump",
				edge: { block: join, arguments: [callee!] },
			});
			caller.setTerminator(decision, {
				kind: "branch",
				condition,
				consequent: { block: selected, arguments: [] },
				alternate: { block: alternate, arguments: [] },
			});
			decision = alternate;
		}
		const [lastCallee] = caller.appendInstruction(decision, "createFunction", [], {
			attributes: { functionIndex: 5 },
		});
		caller.setTerminator(decision, {
			kind: "jump",
			edge: { block: join, arguments: [lastCallee!] },
		});
		const [receiver] = caller.appendInstruction(join, "createUndefined", []);
		const [argument] = caller.appendInstruction(join, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [result] = caller.appendInstruction(join, "call", [
			inspectCoreBlockParameters(caller, join)[0]!.value,
			receiver!,
			argument!,
		]);
		caller.setTerminator(join, { kind: "return", value: result! });
		const callerId = caller.finish(entry).function;
		const leaves = Array.from({ length: 5 }, () => {
			const leaf = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const leafEntry = leaf.createBlock([{ representation: "boxed" }]);
			leaf.setTerminator(leafEntry, {
				kind: "return",
				value: inspectCoreBlockParameters(leaf, leafEntry)[0]!.value,
			});
			return leaf.finish(leafEntry).function;
		});
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const kinds = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" });

		expect(kinds.values(callerId).kindMask(result!)).toBe(COMPILER_VALUE_KIND_STRING);
		for (const leaf of leaves) {
			expect(kinds.summary(leaf).parameterKinds).toEqual([COMPILER_VALUE_KIND_STRING]);
		}
	});

	it("dirties the aggregate without invalidating every function", () => {
		const program = analysisProgram();
		const wildcard = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = wildcard.createBlock([{ representation: "boxed" }]);
		const condition = inspectCoreBlockParameters(wildcard, entry)[0]!.value;
		const join = wildcard.createBlock([{ representation: "boxed" }]);
		let decision = entry;
		for (let functionIndex = 1; functionIndex < 5; functionIndex++) {
			const selected = wildcard.createBlock();
			const alternate = wildcard.createBlock();
			const [callee] = wildcard.appendInstruction(selected, "createFunction", [], {
				attributes: { functionIndex },
			});
			wildcard.setTerminator(selected, {
				kind: "jump",
				edge: { block: join, arguments: [callee!] },
			});
			wildcard.setTerminator(decision, {
				kind: "branch",
				condition,
				consequent: { block: selected, arguments: [] },
				alternate: { block: alternate, arguments: [] },
			});
			decision = alternate;
		}
		const [lastCallee] = wildcard.appendInstruction(decision, "createFunction", [], {
			attributes: { functionIndex: 5 },
		});
		wildcard.setTerminator(decision, {
			kind: "jump",
			edge: { block: join, arguments: [lastCallee!] },
		});
		const [receiver] = wildcard.appendInstruction(join, "createUndefined", []);
		const [argument] = wildcard.appendInstruction(join, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [result] = wildcard.appendInstruction(join, "call", [
			inspectCoreBlockParameters(wildcard, join)[0]!.value,
			receiver!,
			argument!,
		]);
		wildcard.setTerminator(join, { kind: "return", value: result! });
		wildcard.finish(entry);
		for (let index = 0; index < 5; index++) appendLeaf(program);
		const isolatedBuilder = new CoreFunctionBuilder(program, {
			parameterCount: 1,
			metadata: { sourcePath: "/isolated.js" },
		});
		const isolatedEntry = isolatedBuilder.createBlock([{ representation: "boxed" }]);
		isolatedBuilder.appendInstruction(isolatedEntry, "createUndefined", []);
		const [isolatedValueInstruction] = isolatedBuilder.bodyInstructionIds(isolatedEntry);
		isolatedBuilder.setTerminator(isolatedEntry, {
			kind: "return",
			value: inspectCoreBlockParameters(isolatedBuilder, isolatedEntry)[0]!.value,
		});
		const isolated = isolatedBuilder.finish(isolatedEntry);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const initial = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		});
		expect(initial.summary(isolated.function).parameterKinds).toEqual([
			COMPILER_VALUE_KIND_STRING,
		]);

		const editor = CoreEditor.open(program, isolated.function);
		editor.replaceInstruction(isolatedValueInstruction!, "createUndefined", []);
		editor.commit();
		const updated = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		});

		expect(updated.statistics).toMatchObject({
			affectedFunctions: 1,
			functionsReused: 6,
			aggregateRecomputations: 1,
		});
		expect(updated.summary(isolated.function).parameterKinds).toEqual([
			COMPILER_VALUE_KIND_STRING,
		]);
	});
});
