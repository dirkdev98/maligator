import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	coreBuiltinCallbackInvocation,
	refineCoreBuiltinCallbackEffects,
} from "../src/compiler/core/core-builtin-effects.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	cloneCoreFunction,
	coreFunctionIsCloneable,
} from "../src/compiler/core/core-function-clone.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreInstructionEffects } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	analyzeCoreNativeEntry,
	coreNativeEntryProofIsCurrent,
} from "../src/compiler/core/core-native-entry-analysis.ts";
import {
	coreInstructionFactPlans,
	coreInstructionFactProofIsCurrent,
} from "../src/compiler/core/core-native-instruction-facts.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { decodeInstructionEffects } from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function callbackProgram(attributes = {}) {
	const program = analysisProgram();
	const root = new CoreFunctionBuilder(program);
	const entry = root.createBlock();
	const [receiver] = root.appendInstruction(entry, "loadGlobal", [], {
		attributes: { index: 0 },
	});
	const [callback] = root.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: 1 },
	});
	const [result] = root.appendInstruction(entry, "callKnown", [receiver!, callback!], {
		attributes: { operation: "Map.prototype.forEach", ...attributes },
	});
	const call = root.bodyInstructionIds(entry).at(-1)!;
	root.setTerminator(entry, { kind: "return", value: result! });
	const rootFn = program.function(root.finish(entry).function);
	const target = new CoreFunctionBuilder(program);
	const targetEntry = target.createBlock();
	const [empty] = target.appendInstruction(targetEntry, "createUndefined", []);
	target.setTerminator(targetEntry, { kind: "return", value: empty! });
	const callbackFn = program.function(target.finish(targetEntry).function);
	const analyses = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	const summaries = () =>
		analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	return {
		program,
		root: rootFn,
		callback: callbackFn,
		entry,
		targetEntry,
		empty: empty!,
		call,
		analyses,
		summaries,
	};
}

describe("builtin callback effect dependencies", () => {
	it("refreshes callback effects, canonical facts and native entries after a remote body edit", () => {
		const { program, root, callback, targetEntry, empty, call, analyses, summaries } =
			callbackProgram();
		expect(summaries().targets.graph.exactCallers(callback.id)).toContain(root.id);
		expect(summaries().summary(root.id)?.effects.callsUserCode).toBe(false);
		refineCoreBuiltinCallbackEffects(program, summaries());
		expect(coreInstructionEffects(root, call)).toMatchObject({
			writes: [],
			callsUserCode: false,
			mayGc: true,
			mayThrow: true,
		});
		const [facts] = coreInstructionFactPlans(program, analyses, [root.id]);
		const variant = analyzeCoreNativeEntry(
			program,
			buildCoreControlFlow(program, root.id),
			[],
			undefined,
			[],
		);
		const entry = {
			id: 0,
			function: root.id,
			parameterRepresentations: [],
			callSites: [],
			...variant,
			target: "native" as const,
			fallback: "canonical-core" as const,
			cost: { generatedCode: 1, compilerWork: 1, runtimeBenefit: 1 },
		};
		expect(coreInstructionFactProofIsCurrent(program, facts!)).toBe(true);
		expect(coreNativeEntryProofIsCurrent(root, entry)).toBe(true);
		const edit = CoreEditor.open(program, callback.id);
		edit.insertInstruction(targetEntry, undefined, "storeGlobal", [empty], {
			attributes: { index: 2 },
		});
		edit.commit();
		expect(coreInstructionFactProofIsCurrent(program, facts!)).toBe(false);
		expect(coreNativeEntryProofIsCurrent(root, entry)).toBe(false);
		expect(summaries().summary(root.id)?.effects.writes).toContain("global-slot");
		refineCoreBuiltinCallbackEffects(program, summaries());
		expect(coreInstructionEffects(root, call).writes).toContain("global-slot");
	});

	it("converges recursive callbacks and withdraws and rediscovers effects when they become opaque", () => {
		const { program, root, callback, targetEntry, empty, call, summaries } =
			callbackProgram();
		const recursive = CoreEditor.open(program, callback.id);
		const receiver = recursive.insertInstruction(
			targetEntry,
			undefined,
			"loadGlobal",
			[],
			{ attributes: { index: 0 } },
		).outputs[0]!;
		const self = recursive.insertInstruction(targetEntry, undefined, "loadCallee", [])
			.outputs[0]!;
		recursive.insertInstruction(targetEntry, undefined, "callKnown", [receiver, self], {
			attributes: { operation: "Map.prototype.forEach" },
		});
		recursive.commit();
		expect(summaries().targets.graph.exactCallers(callback.id)).toContain(callback.id);
		refineCoreBuiltinCallbackEffects(program, summaries());
		expect(coreInstructionEffects(root, call).callsUserCode).toBe(false);
		const open = CoreEditor.open(program, callback.id);
		const unknown = open.insertInstruction(targetEntry, undefined, "loadGlobal", [], {
			attributes: { index: 1 },
		}).outputs[0]!;
		const invocation = open.insertInstruction(targetEntry, undefined, "call", [
			unknown,
			empty,
		]).instruction;
		open.commit();
		expect(summaries().summary(root.id)?.effects.callsUserCode).toBe(true);
		refineCoreBuiltinCallbackEffects(program, summaries());
		expect(root.instructionEffectRefinement(call)).toBeUndefined();
		const close = CoreEditor.open(program, callback.id);
		close.replaceInstruction(invocation, "createUndefined", []);
		close.commit();
		refineCoreBuiltinCallbackEffects(program, summaries());
		expect(coreInstructionEffects(root, call).callsUserCode).toBe(false);
	});

	it("drops function-scoped effects on cloning and reproves the clone's callback", () => {
		const { program, root, call, summaries } = callbackProgram();
		refineCoreBuiltinCallbackEffects(program, summaries());
		expect(root.instructionEffectRefinement(call)).toBeDefined();
		expect(coreFunctionIsCloneable(root)).toBe(true);
		const clone = program.function(cloneCoreFunction(program, root));
		const copied = [...clone.instructionIds()].find(
			(id) => clone.instructionOpcodeName(id) === "callKnown",
		)!;
		expect(clone.instructionEffectRefinement(copied)).toBeUndefined();
		refineCoreBuiltinCallbackEffects(program, summaries());
		expect(coreInstructionEffects(clone, copied).callsUserCode).toBe(false);
	});

	it.each([{ construct: true }, { argumentMode: "iterable" }])(
		"withholds callback-only effects during invocation preparation %j",
		(attributes) => {
			const { root, call } = callbackProgram(attributes);
			expect(coreBuiltinCallbackInvocation(root, call)).toBeUndefined();
		},
	);
});

describe("callback effects through native lowering", () => {
	it.each(["function", "function*", "async function", "async function*"])(
		"carries effects through %s entries and artifact restoration",
		(declaration) => {
			const suspend =
				(declaration.includes("*") ? "yield input;" : "") +
				(declaration.startsWith("async") ? "await 0;" : "");
			const out = inspectStaticValueFunction(
				`const map=new Map();const pure=function pure(value){for(let i=0;i<3;i++){}return typeof value;};${declaration} compute(input){const record={x:input};const before=record.x;${suspend}Map.prototype.forEach.call(map,pure,record);return before===record.x;}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === "Map.prototype.forEach",
			);
			expect(ip).toBeGreaterThanOrEqual(0);
			expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toMatchObject({
				writes: [],
				callsUserCode: false,
				mayGc: true,
				mayThrow: true,
			});
			expect(out.core.some((op) => op.opcode === "loadPropertyStatic")).toBe(false);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			const native = restored.native.functions[out.native.functionIndex]!;
			expect(
				emitCompiledFunction(
					native,
					native.functionIndex,
					"",
					false,
					"static",
					new Set(),
					[],
					new Map(),
					false,
					new Set(),
					restored.runtime.stringConstants,
				)?.source,
			).toBe(out.c.source);
		},
	);

	it.each(["Number.isFinite", "Array.isArray"])(
		"uses a captured builtin callback's %s contract",
		(callback) => {
			const out = inspectStaticValueFunction(
				`function compute(map,input){const record={x:input};const before=record.x;Map.prototype.forEach.call(map,${callback},record);return before===record.x;}globalThis.compute=compute;`,
				"compute",
				{ realms: false },
			);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL_KNOWN" && op.operation === "Map.prototype.forEach",
			);
			expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toMatchObject({
				writes: [],
				callsUserCode: false,
				mayGc: true,
				mayThrow: true,
			});
		},
	);

	it.each([
		"input",
		"new Proxy(function callback(){},{})",
		"function callback(){this.x=99;}",
	])("keeps opaque or mutating callback effects for %s", (callback) => {
		const out = inspectStaticValueFunction(
			`function compute(map,input){return Map.prototype.forEach.call(map,${callback});}globalThis.compute=compute;`,
			"compute",
			{ realms: false },
		);
		const ip = out.native.body.instructions.findIndex(
			(op) =>
				op.opcode === "CALL" ||
				(op.opcode === "CALL_KNOWN" && op.operation === "Map.prototype.forEach"),
		);
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toMatchObject({
			callsUserCode: true,
			mayGc: true,
			mayThrow: true,
		});
	});

	it("keeps validation for a mixed callable and noncallable callback", () => {
		const out = inspectStaticValueFunction(
			"function compute(map,flag){return Map.prototype.forEach.call(map,flag?function callback(){}:17);}globalThis.compute=compute;",
			"compute",
			{ realms: false },
		);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Map.prototype.forEach",
		);
		expect(decodeInstructionEffects(out.native.facts![ip]!.effectMask!)).toMatchObject({
			callsUserCode: false,
			mayThrow: true,
			mayGc: true,
		});
	});
});
