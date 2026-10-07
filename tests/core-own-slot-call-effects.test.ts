import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function ownSlotProgram() {
	const program = new CoreProgram(coreOpcodeRegistry, {
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
