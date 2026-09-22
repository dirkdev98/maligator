import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CORE_NO_EFFECTS } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import {
	CORE_PROGRAM_VALUE_KIND_ANALYSIS,
	CORE_PROGRAM_FLOW_ANALYSIS,
} from "../src/compiler/core/core-program-flow-analysis.ts";
import type { CoreFunctionStore, CoreProgram } from "../src/compiler/core/core-store.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
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
	const engineSource = readFileSync(
		new URL("../src/compiler/core/core-program-flow.ts", import.meta.url),
		"utf8",
	);

	expect(source).not.toMatch(
		/versionKeys|programValueKindVersionKey|programValueKindTargetsKey/,
	);
	expect(source).not.toMatch(/singleAssignmentGlobalSlots\.join/);
	expect(source).not.toMatch(/CORE_PROGRAM_VALUE_KIND_ANALYSIS|programFlow\.refresh/);
	expect(flowSource).toMatch(/programFlow\.refresh/);
	expect(flowSource).toMatch(/epoch\.dirtyFunctionAt/);
	expect(flowSource).toMatch(/programFlow\.solveValueKinds\(/);
	expect(engineSource).toMatch(/solveValueKinds<.*CoreProgramFlowTargetIndex/s);
	expect(source).toMatch(/new CoreProgramFlowEngine\(program\)\.solveValueKinds\(/);
	expect(source).not.toMatch(
		/solveCoreProgramFlowSccs|\.solveSccs\(|activeSccs|pendingFunctionSccs/,
	);
	expect(source).not.toMatch(
		/interface KindTransfer\s*\{|readonly evaluate|evaluate:\s*\(/,
	);
	expect(source).not.toMatch(/Array\.from\(\{ length: operandCount/);
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

function compileRecursiveObservation(
	sourceClosed: boolean,
	published = false,
): {
	readonly program: CoreProgram;
	readonly valueKindFolds: number;
	readonly waves: number;
	readonly programFlowResolves: number;
	readonly callerEditSessions: number;
	readonly callerLocalOptimizations: number;
} {
	const sourcePath = published
		? "core-program-value-kinds.js"
		: "core-program-value-kinds.mjs";
	const source = `function observe(text, absent, count) {
			if (count > 0) return observe(text, absent, count - 1);
			return typeof text === "string" && text !== 1 && !absent;
		}
		globalThis.result = observe("value", null, globalThis.count);`;
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		sourcePath,
		published ? undefined : parseModule(source),
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
	it.each(["-", "+", "~", "increment", "decrement", "tonumeric"])(
		"propagates normal-completion %s result kinds across a forward call edge",
		(operator) => {
			for (const unknown of [false, true]) {
				const program = analysisProgram();
				const caller = new CoreFunctionBuilder(program);
				const entry = caller.createBlock();
				const [callee] = caller.appendInstruction(entry, "createFunction", [], {
					attributes: { functionIndex: 1 },
				});
				const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
				const [called] = caller.appendInstruction(entry, "call", [callee!, receiver!]);
				const [result] = caller.appendInstruction(entry, "unary", [called!], {
					attributes: { operator },
				});
				caller.setTerminator(entry, { kind: "return", value: result! });
				const callerId = caller.finish(entry).function;
				const leaf = appendLeaf(program);
				if (unknown) {
					const editor = CoreEditor.open(program, leaf.function);
					editor.replaceInstruction(leaf.valueInstruction, "loadGlobal", [], {
						attributes: { index: 0 },
					});
					editor.commit();
				}
				const manager = new CoreAnalysisManager(
					program,
					programAnalysisContext(),
					new CoreOptimizationReportBuilder(program),
				);
				const kinds = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
					scope: "program",
				}).kinds;
				expect(kinds.summary(callerId).returnKind).toBe(
					unknown && operator !== "+"
						? COMPILER_VALUE_KIND_TOP
						: COMPILER_VALUE_KIND_NUMBER,
				);
			}
		},
	);

	it("propagates closed primitive kinds through a recursive caller SCC", () => {
		const result = compileRecursiveObservation(true);
		const optimized = result.program;
		const observe = coreFunctionNamed(optimized, "observe")!;
		expect(coreOperations(observe).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(observations(observe)).toEqual([]);
		expect(result.valueKindFolds).toBeGreaterThan(0);
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
		const { program: optimized } = compileRecursiveObservation(false);
		const observe = coreFunctionNamed(optimized, "observe")!;
		expect(observations(observe).length).toBeGreaterThan(0);
	});

	it("keeps parameter observations for a function published on the global object", () => {
		const { program, valueKindFolds } = compileRecursiveObservation(true, true);
		expect(observations(coreFunctionNamed(program, "observe")!).length).toBeGreaterThan(
			0,
		);
		expect(valueKindFolds).toBe(0);
	});

	it.each([
		["object property", "globalThis.sink = { callback: observe };"],
		["array element", "globalThis.sink = [observe];"],
		[
			"catch handler",
			"try { JSON.parse('!'); } catch { globalThis.sink = { callback: observe }; }",
		],
		["moved identity", "const alias = observe; globalThis.sink = { alias };"],
		[
			"captured identity",
			"function capture() { const alias = observe; return function expose() { globalThis.sink = alias; }; } globalThis.capture = capture();",
		],
		[
			"script argument",
			"function expose(value) { globalThis.sink = value; } expose(observe);",
		],
		["native argument", "globalThis.sink = new Proxy(observe, {});"],
		[
			"returned identity",
			"function expose() { return observe; } globalThis.sink = expose;",
		],
		[
			"thrown identity",
			"try { throw observe; } catch (value) { globalThis.sink = value; }",
		],
		[
			"yielded identity",
			"function* expose() { yield observe; } globalThis.sink = expose;",
		],
	])(
		"keeps unknown parameter kinds for a callback exposed through an %s",
		(_name, publication) => {
			const sourcePath = "published-callback.mjs";
			const source = `function observe(value) {
			if (globalThis.again) return observe(value);
			return typeof value === "string";
		}
		${publication}
		globalThis.result = observe(1);`;
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, sourcePath, parseModule(source)),
				{
					facts: withProgramClosure(
						compilerProgramFactsFromConfig(
							resolveBuildConfig({ engine: { eval: false } }),
						),
						programClosureCertificate(
							{ kind: "whole-program", entry: sourcePath },
							[],
							[],
						),
					),
					afterCoreOptimization(program) {
						optimized = program;
					},
				},
			);
			expect(
				observations(coreFunctionNamed(optimized!, "observe")!).length,
			).toBeGreaterThan(0);
		},
	);

	it("widens and narrows callback inputs when publication changes without changing its call edge", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const [callee] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
		const [argument] = caller.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		caller.appendInstruction(entry, "rootUse", [callee!]);
		const publication = [...caller.bodyInstructionIds(entry)].at(-1)!;
		const [result] = caller.appendInstruction(entry, "call", [
			callee!,
			receiver!,
			argument!,
		]);
		caller.setTerminator(entry, { kind: "return", value: result! });
		const callerId = caller.finish(entry).function;
		const leaf = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const leafEntry = leaf.createBlock([{ representation: "boxed" }]);
		leaf.setTerminator(leafEntry, {
			kind: "return",
			value: inspectCoreBlockParameters(leaf, leafEntry)[0]!.value,
		});
		const leafId = leaf.finish(leafEntry).function;
		const unrelated = appendLeaf(program);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		expect(
			manager
				.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" })
				.kinds.summary(leafId).parameterKinds,
		).toEqual([COMPILER_VALUE_KIND_STRING]);
		for (const published of [true, false]) {
			const editor = CoreEditor.open(program, callerId);
			editor.replaceInstruction(
				publication,
				published ? "storeGlobalProperty" : "rootUse",
				[callee!],
				{
					attributes: published ? { nameStringIndex: 0 } : {},
				},
			);
			editor.commit();
			manager.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
			const other = CoreEditor.open(program, unrelated.function);
			other.replaceInstruction(unrelated.valueInstruction, "createBoolean", [], {
				attributes: { value: published },
			});
			other.commit();
			manager.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
			expect(
				manager
					.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" })
					.kinds.summary(leafId).parameterKinds,
			).toEqual([published ? COMPILER_VALUE_KIND_TOP : COMPILER_VALUE_KIND_STRING]);
		}
	});

	it("updates callback publication when throwing effects or handler edges change", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const protectedBlock = caller.createBlock();
		const normal = caller.createBlock();
		const handler = caller.createBlock([{ role: "exception" }, {}]);
		const [callee] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
		const [argument] = caller.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [number] = caller.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		caller.setTerminator(entry, {
			kind: "jump",
			edge: { block: protectedBlock, arguments: [] },
		});
		caller.appendInstruction(protectedBlock, "unary", [number!], {
			attributes: { operator: "+" },
		});
		const conversion = [...caller.bodyInstructionIds(protectedBlock)][0]!;
		caller.setHandler(protectedBlock, handler, [callee!]);
		caller.setTerminator(protectedBlock, {
			kind: "jump",
			edge: { block: normal, arguments: [] },
		});
		caller.appendInstruction(
			handler,
			"storeGlobalProperty",
			[caller.blockParameterValue(handler, 1)],
			{ attributes: { nameStringIndex: 0 } },
		);
		caller.setTerminator(handler, { kind: "return", value: receiver! });
		const [result] = caller.appendInstruction(normal, "call", [
			callee!,
			receiver!,
			argument!,
		]);
		caller.setTerminator(normal, { kind: "return", value: result! });
		const callerId = caller.finish(entry).function;
		const leaf = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const leafEntry = leaf.createBlock([{}]);
		leaf.setTerminator(leafEntry, {
			kind: "return",
			value: leaf.blockParameterValue(leafEntry, 0),
		});
		const leafId = leaf.finish(leafEntry).function;
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const parameterKinds = () =>
			manager
				.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" })
				.kinds.summary(leafId).parameterKinds;
		expect(parameterKinds()).toEqual([COMPILER_VALUE_KIND_TOP]);
		const refined = CoreEditor.open(program, callerId);
		const proof = refined.addFact({
			kind: "number-conversion",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "number-conversion" },
			obligations: [],
			origin: "test",
		});
		refined.setInstructionEffectRefinement(conversion, {
			effects: CORE_NO_EFFECTS,
			proof,
		});
		refined.commit();
		expect(parameterKinds()).toEqual([COMPILER_VALUE_KIND_STRING]);
		const cleared = CoreEditor.open(program, callerId);
		cleared.clearInstructionEffectRefinement(conversion);
		cleared.commit();
		expect(parameterKinds()).toEqual([COMPILER_VALUE_KIND_TOP]);
		const removed = CoreEditor.open(program, callerId);
		removed.clearHandler(protectedBlock);
		removed.commit();
		expect(parameterKinds()).toEqual([COMPILER_VALUE_KIND_STRING]);
		const restored = CoreEditor.open(program, callerId);
		restored.setHandler(protectedBlock, handler, [callee!]);
		restored.commit();
		expect(parameterKinds()).toEqual([COMPILER_VALUE_KIND_TOP]);
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
		const first = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;
		const unrelatedValues = first.values(unrelated.function);

		const editor = CoreEditor.open(program, edited.function);
		editor.replaceInstruction(edited.valueInstruction, "createBoolean", [], {
			attributes: { value: true },
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;

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

	it("keeps the dirty value-kind component small as unrelated functions grow", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		const edited = appendLeaf(program);
		const unrelated = Array.from({ length: 64 }, () =>
			appendLeaf(program, "/unrelated.js"),
		);
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const first = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;
		const unrelatedValues = first.values(unrelated.at(-1)!.function);

		const editor = CoreEditor.open(program, edited.function);
		editor.replaceInstruction(edited.valueInstruction, "createBoolean", [], {
			attributes: { value: true },
		});
		editor.commit();
		const second = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;

		expect(second.statistics).toMatchObject({
			functions: 66,
			functionsEvaluated: 3,
			functionsReused: 64,
			affectedFunctions: 2,
		});
		expect(second.values(unrelated.at(-1)!.function)).toBe(unrelatedValues);
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
		const kinds = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;
		expect(kinds.statistics.functionsEvaluated).toBeLessThanOrEqual(length * 2);
	});

	it.each([false, true])(
		"joins capped call-target inputs with publication=%s",
		(published) => {
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
			if (published) {
				const [alias] = caller.appendInstruction(join, "move", [
					inspectCoreBlockParameters(caller, join)[0]!.value,
				]);
				caller.appendInstruction(join, "storeGlobalProperty", [alias!], {
					attributes: { nameStringIndex: 0 },
				});
			}
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
			const kinds = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
				scope: "program",
			}).kinds;

			const expected = published ? COMPILER_VALUE_KIND_TOP : COMPILER_VALUE_KIND_STRING;
			expect(kinds.values(callerId).kindMask(result!)).toBe(expected);
			for (const leaf of leaves) {
				expect(kinds.summary(leaf).parameterKinds).toEqual([expected]);
			}
		},
	);

	it("publishes every writer when an escaping shared cell exceeds the target cap", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
		for (let functionIndex = 1; functionIndex <= 5; functionIndex++) {
			const [writer] = caller.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex },
			});
			caller.appendInstruction(entry, "call", [writer!, receiver!]);
		}
		const [loaded] = caller.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		caller.appendInstruction(entry, "storeGlobalProperty", [loaded!], {
			attributes: { nameStringIndex: 0 },
		});
		const [argument] = caller.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		const [result] = caller.appendInstruction(entry, "call", [
			loaded!,
			receiver!,
			argument!,
		]);
		caller.setTerminator(entry, { kind: "return", value: result! });
		caller.finish(entry);
		for (let functionIndex = 6; functionIndex <= 10; functionIndex++) {
			const writer = new CoreFunctionBuilder(program);
			const block = writer.createBlock();
			const [value] = writer.appendInstruction(block, "createFunction", [], {
				attributes: { functionIndex },
			});
			writer.appendInstruction(block, "storeGlobal", [value!], {
				attributes: { index: 0 },
			});
			const [returned] = writer.appendInstruction(block, "createUndefined", []);
			writer.setTerminator(block, { kind: "return", value: returned! });
			writer.finish(block);
		}
		const leaves = Array.from({ length: 5 }, () => {
			const leaf = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const block = leaf.createBlock([{ representation: "boxed" }]);
			leaf.setTerminator(block, {
				kind: "return",
				value: inspectCoreBlockParameters(leaf, block)[0]!.value,
			});
			return leaf.finish(block).function;
		});
		const manager = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		);
		const kinds = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;
		for (const leaf of leaves)
			expect(kinds.summary(leaf).parameterKinds).toEqual([COMPILER_VALUE_KIND_TOP]);
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
		}).kinds;
		expect(initial.summary(isolated.function).parameterKinds).toEqual([
			COMPILER_VALUE_KIND_STRING,
		]);

		const editor = CoreEditor.open(program, isolated.function);
		editor.replaceInstruction(isolatedValueInstruction!, "createUndefined", []);
		editor.commit();
		const updated = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;

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
