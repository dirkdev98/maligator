import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreMemoryVersions } from "../src/compiler/core/core-ir-memory.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionEffects } from "../src/compiler/core/core-ir-opcodes.ts";
import { buildCoreProvenance } from "../src/compiler/core/core-ir-provenance.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { forwardCoreOwnSlotCallLoads } from "../src/compiler/core/core-own-slot-call-loads.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { coreFunctionNamed } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function ownSlotProgram() {
	const program = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 1,
		stringConstants: [[0x78], [0x79]],
	});
	const analyses = new CoreAnalysisManager(
		program,
		programAnalysisContext(),
		new CoreOptimizationReportBuilder(program),
	);
	return {
		program,
		analyses,
		summaries: () => analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" }),
	};
}

function appendFieldCaller(
	program: CoreProgram,
	target: number,
	option: "ordinary" | "missing slot" | "escaped" | "same value" | "opaque" = "ordinary",
) {
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const [first] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 11 },
	});
	const [second] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 22 },
	});
	const [object] = builder.appendInstruction(
		entry,
		"createObjectShaped",
		option === "missing slot" ? [first!] : [first!, second!],
		{ attributes: { keyStringIndices: option === "missing slot" ? [0] : [0, 1] } },
	);
	const allocation = builder.bodyInstructionIds(entry).at(-1)!;
	const [callee] =
		option === "opaque"
			? builder.appendInstruction(entry, "loadGlobal", [], { attributes: { index: 0 } })
			: builder.appendInstruction(entry, "createFunction", [], {
					attributes: { functionIndex: target },
				});
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	if (option === "escaped") {
		const [unknown] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(entry, "call", [unknown!, receiver!, object!]);
	}
	const [before] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
		attributes: { stringIndex: 0 },
	});
	builder.appendInstruction(entry, "rootUse", [before!]);
	builder.appendInstruction(entry, "call", [
		callee!,
		receiver!,
		object!,
		option === "same value" ? object! : second!,
	]);
	const call = builder.bodyInstructionIds(entry).at(-1)!;
	const [after] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
		attributes: { stringIndex: 0 },
	});
	const load = builder.bodyInstructionIds(entry).at(-1)!;
	builder.appendInstruction(entry, "rootUse", [after!]);
	const [written] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
		attributes: { stringIndex: 1 },
	});
	const writtenLoad = builder.bodyInstructionIds(entry).at(-1)!;
	builder.setTerminator(entry, { kind: "return", value: written! });
	const fn = program.function(builder.finish(entry).function);
	return { fn, call, load, writtenLoad, allocation, object: object!, entry };
}

function appendWriter(program: CoreProgram, receiver = false) {
	const builder = new CoreFunctionBuilder(program, { parameterCount: receiver ? 1 : 2 });
	const entry = builder.createBlock(receiver ? [{}] : [{}, {}]);
	const value = builder.blockParameterValue(entry, receiver ? 0 : 1);
	const base = receiver
		? builder.appendInstruction(entry, "loadThis", [])[0]!
		: builder.blockParameterValue(entry, 0);
	const [alias] = builder.appendInstruction(entry, "move", [base]);
	builder.appendInstruction(entry, "storePropertyStatic", [alias!, value], {
		attributes: { stringIndex: 1 },
	});
	const store = builder.bodyInstructionIds(entry).at(-1)!;
	const [read] = builder.appendInstruction(entry, "loadPropertyStatic", [alias!], {
		attributes: { stringIndex: 0 },
	});
	builder.setTerminator(entry, { kind: "return", value: read! });
	const fn = program.function(builder.finish(entry).function);
	return { fn, store, base, entry };
}

describe("conditional own-slot call effects", () => {
	it("forwards the untouched field while retaining the call, allocation and written-field load", () => {
		const { program, analyses } = ownSlotProgram();
		const writer = appendWriter(program);
		const caller = appendFieldCaller(program, writer.fn.id);
		const effects = coreInstructionEffects(caller.fn, caller.call);
		expect(forwardCoreOwnSlotCallLoads(program, analyses)).toEqual([caller.fn.id]);
		expect(caller.fn.isInstructionLive(caller.load)).toBe(false);
		expect(caller.fn.isInstructionLive(caller.writtenLoad)).toBe(true);
		expect(caller.fn.isInstructionLive(caller.call)).toBe(true);
		expect(caller.fn.isInstructionLive(caller.allocation)).toBe(true);
		expect(coreInstructionEffects(caller.fn, caller.call)).toEqual(effects);
		verifyCoreProgram(program, { stage: "pre-target" }, programAnalysisContext());
	});

	it.each(["missing slot", "escaped", "same value", "opaque"] as const)(
		"preserves the whole barrier for %s",
		(option) => {
			const { program, analyses } = ownSlotProgram();
			const writer = appendWriter(program);
			const caller = appendFieldCaller(program, writer.fn.id, option);
			expect(forwardCoreOwnSlotCallLoads(program, analyses)).toEqual([]);
			expect(caller.fn.isInstructionLive(caller.load)).toBe(true);
			expect(caller.fn.isInstructionLive(caller.call)).toBe(true);
		},
	);

	it("refreshes a same-domain callee key edit before a subsequent caller analysis", () => {
		const { program, analyses } = ownSlotProgram();
		const writer = appendWriter(program);
		const original = appendFieldCaller(program, writer.fn.id);
		expect(forwardCoreOwnSlotCallLoads(program, analyses)).toEqual([original.fn.id]);
		const edit = CoreEditor.open(program, writer.fn.id);
		edit.replaceInstruction(
			writer.store,
			"storePropertyStatic",
			[writer.base, writer.fn.kernel.functionParameter(1)],
			{ attributes: { stringIndex: 0 } },
		);
		edit.commit();
		const next = appendFieldCaller(program, writer.fn.id);
		forwardCoreOwnSlotCallLoads(program, analyses);
		expect(next.fn.isInstructionLive(next.load)).toBe(true);
		expect(next.fn.isInstructionLive(next.writtenLoad)).toBe(false);
	});

	it("declines atomic substitution when another relative base escapes", () => {
		const { program, analyses } = ownSlotProgram();
		const writer = appendWriter(program);
		const edit = CoreEditor.open(program, writer.fn.id);
		const [value] = edit.insertInstruction(
			writer.entry,
			writer.store,
			"createNumber",
			[],
			{ attributes: { value: 1 } },
		).outputs;
		edit.replaceInstruction(writer.store, "storePropertyStatic", [writer.base, value!], {
			attributes: { stringIndex: 1 },
		});
		edit.insertInstruction(
			writer.entry,
			writer.store,
			"storePropertyStatic",
			[writer.fn.kernel.functionParameter(1), value!],
			{ attributes: { stringIndex: 0 } },
		);
		edit.commit();
		const caller = appendFieldCaller(program, writer.fn.id);
		const editor = CoreEditor.open(program, caller.fn.id);
		const [unknown] = editor.insertInstruction(
			caller.entry,
			caller.call,
			"loadGlobal",
			[],
			{ attributes: { index: 0 } },
		).outputs;
		const [other] = editor.insertInstruction(
			caller.entry,
			caller.call,
			"createObjectShaped",
			[
				caller.fn.kernel.operandAt(
					caller.fn.kernel.instructionOperandStart(caller.call) + 3,
				),
			],
			{ attributes: { keyStringIndices: [0] } },
		).outputs;
		const [receiver] = editor.insertInstruction(
			caller.entry,
			caller.call,
			"createUndefined",
			[],
		).outputs;
		editor.insertInstruction(caller.entry, caller.call, "call", [
			unknown!,
			receiver!,
			other!,
		]);
		const callee = caller.fn.kernel.operandAt(
			caller.fn.kernel.instructionOperandStart(caller.call),
		);
		editor.replaceInstruction(caller.call, "call", [
			callee,
			receiver!,
			caller.object,
			other!,
		]);
		editor.commit();
		expect(forwardCoreOwnSlotCallLoads(program, analyses)).toEqual([]);
		expect(caller.fn.isInstructionLive(caller.load)).toBe(true);
	});

	it("keeps every aliased write in the instantiated transfer", () => {
		const { program, analyses } = ownSlotProgram();
		const writer = appendWriter(program);
		const edit = CoreEditor.open(program, writer.fn.id);
		const value = edit.insertInstruction(writer.entry, writer.store, "createNumber", [], {
			attributes: { value: 1 },
		}).outputs[0]!;
		edit.replaceInstruction(writer.store, "storePropertyStatic", [writer.base, value], {
			attributes: { stringIndex: 1 },
		});
		edit.insertInstruction(
			writer.entry,
			writer.store,
			"storePropertyStatic",
			[writer.fn.kernel.functionParameter(1), value],
			{ attributes: { stringIndex: 0 } },
		);
		edit.commit();
		const caller = appendFieldCaller(program, writer.fn.id, "same value");
		expect(forwardCoreOwnSlotCallLoads(program, analyses)).toEqual([caller.fn.id]);
		expect(caller.fn.isInstructionLive(caller.load)).toBe(true);
		expect(caller.fn.isInstructionLive(caller.writtenLoad)).toBe(true);
	});

	it("boxes a typed initializer into the existing load result without changing the call", () => {
		const { program, analyses } = ownSlotProgram();
		const writer = appendWriter(program),
			caller = appendFieldCaller(program, writer.fn.id);
		const source = caller.fn.kernel.operandAt(
			caller.fn.kernel.instructionOperandStart(caller.allocation),
		);
		const edit = CoreEditor.open(program, caller.fn.id);
		edit.setValueRepresentation(source, "f64");
		edit.commit();
		expect(forwardCoreOwnSlotCallLoads(program, analyses)).toEqual([caller.fn.id]);
		expect(caller.fn.instructionOpcodeName(caller.load)).toBe("move");
		expect(
			caller.fn.valueRepresentation(
				caller.fn.kernel.resultAt(caller.fn.kernel.instructionResultStart(caller.load)),
			),
		).toBe("boxed");
		expect(
			caller.fn.kernel.operandAt(caller.fn.kernel.instructionOperandStart(caller.load)),
		).toBe(source);
		expect(caller.fn.isInstructionLive(caller.call)).toBe(true);
		verifyCoreProgram(program, { stage: "pre-target" }, programAnalysisContext());
	});

	it("does not let an exact write mask a residual write in the same domain", () => {
		const { program } = ownSlotProgram();
		const writer = appendWriter(program),
			caller = appendFieldCaller(program, writer.fn.id);
		const control = buildCoreControlFlow(program, caller.fn.id),
			roots = coreCanonicalValueRoots(caller.fn, control);
		const provenance = buildCoreProvenance(program, caller.fn, control, {
			canonicalRoots: roots,
			nonRetainingCallOperands: new Map([[caller.call, new Set([2])]]),
		});
		const resolved = provenance.ownCell(
			caller.object,
			{ kind: "string-constant", index: 0 },
			"read",
		)!;
		const location = {
			kind: "object-slot" as const,
			allocation: resolved.layout.instruction,
			key: 0,
		};
		const memory = analyzeCoreMemoryVersions(program, caller.fn.id, {
			control,
			canonicalRoots: roots,
			provenance,
			instructionTransfers: new Map([
				[
					caller.call,
					{
						accesses: [
							{
								mode: "write",
								base: caller.object,
								key: { kind: "string-constant", index: 1 },
								location: { kind: "object-slot", allocation: caller.allocation, key: 1 },
							},
						],
						residualEffects: {
							reads: [],
							writes: ["object-property"],
							callsUserCode: false,
							mayThrow: true,
							mayGc: true,
							maySuspend: false,
						},
					},
				],
			]),
		});
		expect(memory.valueForRead(caller.load, location)).toBeUndefined();
	});

	it("runs cross-call forwarding in the source pipeline before the final native plan", () => {
		const core = optimizeSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`
			function untouched(value) {
				const setY = (o, value) => { o.y = value; };
				const o = {x:11, y:0}; setY(o, value); return o.x;
			}
			globalThis.result = untouched(7);
		`,
				"/entry.js",
			),
			{
				facts: programAnalysisContext().facts,
				optimization: "development",
				coreOptimizationBenchmarkAblation: { family: "inlining-cross-call" },
				coreVerification: "per-pass",
			},
			(_phase, run) => run(),
		);
		const caller = coreFunctionNamed(core.program, "untouched")!;
		expect(caller).toBeDefined();
		expect(
			[...caller.instructionIds()].some(
				(instruction) =>
					caller.instructionKind(instruction) === "operation" &&
					caller.instructionOpcodeName(instruction) === "call",
			),
		).toBe(true);
		expect(
			[...caller.instructionIds()].some(
				(instruction) =>
					caller.instructionKind(instruction) === "operation" &&
					caller.instructionOpcodeName(instruction) === "loadPropertyStatic",
			),
		).toBe(false);
	});
	it.each([false, true])(
		"accounts for leaf reads and writes while preserving coarse effects (receiver=%s)",
		(receiver) => {
			const { program, summaries } = ownSlotProgram();
			const { fn } = appendWriter(program, receiver);
			const summary = summaries().summary(fn.id)!;
			const base = receiver ? { kind: "receiver" } : { kind: "parameter", index: 0 };
			expect(summary.effects.writes).toContain("object-property");
			expect(summary.effects.callsUserCode).toBe(true);
			expect(summary.conditionalOwnSlotEffects).toMatchObject({
				accesses: [
					{ base, key: 0, mode: "read" },
					{ base, key: 1, mode: "write" },
				],
				residualEffects: {
					writes: [],
					mayThrow: true,
					mayGc: true,
					callsUserCode: false,
					maySuspend: false,
				},
				parameterEscape: receiver ? ["retained"] : ["none", "retained"],
				receiverEscape: "none",
			});
		},
	);

	it("retains a base returned or stored as a value instead of claiming it stays private", () => {
		const { program, summaries } = ownSlotProgram();
		const { fn, base, store, entry } = appendWriter(program);
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceInstruction(store, "storePropertyStatic", [base, base], {
			attributes: { stringIndex: 1 },
		});
		editor.replaceTerminator(entry, { kind: "return", value: base });
		editor.commit();
		expect(
			summaries().summary(fn.id)!.conditionalOwnSlotEffects?.parameterEscape[0],
		).toBe("retained");
	});

	it.each(["coercion", "opaque call", "recursive call", "dynamic key"])(
		"declines a helper with %s",
		(caseName) => {
			const { program, summaries } = ownSlotProgram();
			const { fn, store, base, entry } = appendWriter(program);
			const editor = CoreEditor.open(program, fn.id);
			if (caseName === "coercion") {
				editor.insertInstruction(entry, store, "unary", [base], {
					attributes: { operator: "+" },
				});
			} else if (caseName === "dynamic key") {
				editor.replaceInstruction(store, "storeProperty", [base, base, base]);
			} else {
				const callee =
					caseName === "recursive call"
						? editor.insertInstruction(entry, store, "createFunction", [], {
								attributes: { functionIndex: fn.id },
							}).outputs[0]!
						: base;
				editor.insertInstruction(entry, store, "call", [callee, base]);
			}
			editor.commit();
			expect(summaries().summary(fn.id)!.conditionalOwnSlotEffects).toBeUndefined();
		},
	);

	it.each(["returned", "retained"] as const)(
		"preserves every merged formal that is %s",
		(escape) => {
			const { program, summaries } = ownSlotProgram();
			const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
			const entry = builder.createBlock([{}, {}, {}]);
			const first = builder.blockParameterValue(entry, 0),
				second = builder.blockParameterValue(entry, 1);
			const selected = builder.createBlock(),
				alternate = builder.createBlock(),
				join = builder.createBlock([{}]);
			builder.setTerminator(entry, {
				kind: "branch",
				condition: builder.blockParameterValue(entry, 2),
				consequent: { block: selected, arguments: [] },
				alternate: { block: alternate, arguments: [] },
			});
			builder.setTerminator(selected, {
				kind: "jump",
				edge: { block: join, arguments: [first] },
			});
			builder.setTerminator(alternate, {
				kind: "jump",
				edge: { block: join, arguments: [second] },
			});
			const merged = builder.blockParameterValue(join, 0);
			const [value] = builder.appendInstruction(join, "createNumber", [], {
				attributes: { value: 1 },
			});
			builder.appendInstruction(
				join,
				"storePropertyStatic",
				[first, escape === "retained" ? merged : value!],
				{ attributes: { stringIndex: 1 } },
			);
			builder.setTerminator(join, {
				kind: "return",
				value: escape === "returned" ? merged : value!,
			});
			const fn = builder.finish(entry).function;
			expect(summaries().summary(fn)!.conditionalOwnSlotEffects?.parameterEscape).toEqual(
				[escape, escape, "none"],
			);
		},
	);

	it("publishes a changed exact key even when the coarse effect domains do not change", () => {
		const { program, summaries } = ownSlotProgram();
		const { fn, store, base } = appendWriter(program);
		const before = summaries();
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceInstruction(
			store,
			"storePropertyStatic",
			[base, fn.kernel.functionParameter(1)],
			{ attributes: { stringIndex: 0 } },
		);
		editor.commit();
		const after = summaries();
		expect(after.summary(fn.id)!.effects).toEqual(before.summary(fn.id)!.effects);
		expect(after.version(fn.id)).toBe(before.version(fn.id) + 1);
		expect(after.summary(fn.id)!.conditionalOwnSlotEffects!.accesses).toContainEqual({
			base: { kind: "parameter", index: 0 },
			key: 0,
			mode: "write",
		});
	});

	it("rechecks conditional admission after a handler-only edit", () => {
		const { program, summaries } = ownSlotProgram();
		const { fn, entry } = appendWriter(program);
		const prepare = CoreEditor.open(program, fn.id);
		const handler = prepare.createBlock([{}]);
		prepare.setTerminator(handler, {
			kind: "throw",
			value: prepare.function.kernel.blockParameterValue(
				prepare.function.kernel.blockParameterStart(handler),
			),
		});
		prepare.commit();
		expect(summaries().summary(fn.id)!.conditionalOwnSlotEffects).toBeDefined();
		const before = fn.versions;
		const editor = CoreEditor.open(program, fn.id);
		editor.setHandler(entry, handler);
		editor.commit();
		expect(fn.version("body")).toBe(before.body);
		expect(fn.version("cfg")).toBe(before.cfg);
		expect(summaries().summary(fn.id)!.conditionalOwnSlotEffects).toBeUndefined();
	});
});
