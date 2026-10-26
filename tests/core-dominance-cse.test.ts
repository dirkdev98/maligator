import { describe, expect, it, vi } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import type * as CoreIrEquality from "../src/compiler/core/core-ir-equality.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import type { CoreBlockId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

vi.mock("../src/compiler/core/core-ir-equality.ts", async (importOriginal) => ({
	...(await importOriginal<typeof CoreIrEquality>()),
	coreInstructionInputsHash: () => 0,
}));

describe("dominator-scoped expression availability", () => {
	it.each(["dominance-redundancy-elimination", "partial-redundancy-elimination"])(
		"wakes %s after effect-only purity certification",
		(passName) => {
			const registry = new CoreOpcodeRegistry();
			registry.define({
				opcode: "pair",
				inputs: coreArity(2),
				outputs: coreArity(1),
				effects: { ...CORE_NO_EFFECTS, callsUserCode: true },
				discardable: true,
				attributeRelocations: [],
			});
			const program = new CoreProgram(registry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
			const entry = builder.createBlock([{}, {}, {}]);
			const left = builder.createBlock(),
				right = builder.createBlock(),
				merge = builder.createBlock();
			const inputs = [
				builder.blockParameterValue(entry, 1),
				builder.blockParameterValue(entry, 2),
			];
			const operations = [entry, left, right, merge].map((block) => {
				const value = builder.appendInstruction(block, "pair", inputs)[0]!;
				return { value, instruction: builder.bodyInstructionIds(block).at(-1)! };
			});
			builder.setTerminator(entry, {
				kind: "branch",
				condition: builder.blockParameterValue(entry, 0),
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			for (const block of [left, right])
				builder.setTerminator(block, {
					kind: "jump",
					edge: { block: merge, arguments: [] },
				});
			builder.setTerminator(merge, { kind: "return", value: operations[3]!.value });
			const fn = program.function(builder.finish(entry).function);
			const context = programAnalysisContext(false),
				report = new CoreOptimizationReportBuilder(program);
			const scheduler = new CoreFunctionPassScheduler(
				program,
				context,
				new CoreAnalysisManager(program, context, report),
				report,
				fn.id,
				{ verification: "per-pass" },
			);
			const passes = CORE_CONTROL_FLOW_PASSES.filter(({ name }) => name === passName);
			scheduler.runComponent("control-flow", passes);
			expect(fn.isInstructionLive(operations[3]!.instruction)).toBe(true);
			const editor = CoreEditor.open(program, fn.id);
			for (const { instruction } of operations) {
				const proof = editor.addFact({
					kind: "certified-pair",
					value: true,
					claims: [{ kind: "effect", instruction, effects: CORE_NO_EFFECTS }],
					validity: { kind: "summary", digest: "certified-pair" },
					obligations: [],
					origin: "test",
				});
				editor.setInstructionEffectRefinement(instruction, {
					proof,
					effects: CORE_NO_EFFECTS,
				});
			}
			const changes = editor.commit();
			expect(changes.domains).not.toContain("body");
			scheduler.runComponent("control-flow", passes, [changes]);
			expect(fn.isInstructionLive(operations[3]!.instruction)).toBe(false);
		},
	);

	it.each([false, true])(
		"keeps collision and sibling scopes separate, with effects=%s",
		(withEffects) => {
			const registry = new CoreOpcodeRegistry();
			for (const opcode of ["pair", "effectfulPair"])
				registry.define({
					opcode,
					inputs: coreArity(2),
					outputs: coreArity(1),
					effects:
						opcode === "pair"
							? CORE_NO_EFFECTS
							: { ...CORE_NO_EFFECTS, callsUserCode: true },
					discardable: true,
					attributeRelocations: [],
				});
			const program = new CoreProgram(registry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
			const entry = builder.createBlock([{}, {}, {}]);
			const left = builder.createBlock();
			const nested = builder.createBlock();
			const right = builder.createBlock();
			const merge = builder.createBlock();
			const flag = builder.blockParameterValue(entry, 0);
			const inputs = [
				builder.blockParameterValue(entry, 1),
				builder.blockParameterValue(entry, 2),
			];
			const pair = (block: CoreBlockId, tag: string, opcode = "pair") => {
				const value = builder.appendInstruction(block, opcode, inputs, {
					attributes: { tag },
				})[0]!;
				return { value, instruction: builder.bodyInstructionIds(block).at(-1)! };
			};
			const dominating = pair(entry, "A");
			const leftValue = pair(left, "B");
			const nestedValue = pair(nested, "A");
			const rightValue = pair(right, "B");
			const joined = pair(merge, "B");
			const effects = withEffects
				? [pair(left, "A", "effectfulPair"), pair(right, "A", "effectfulPair")]
				: [];
			builder.setTerminator(entry, {
				kind: "branch",
				condition: flag,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: nested, arguments: [] },
			});
			builder.setTerminator(nested, {
				kind: "jump",
				edge: { block: merge, arguments: [] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: merge, arguments: [] },
			});
			builder.setTerminator(merge, { kind: "return", value: joined.value });
			const fn = program.function(builder.finish(entry).function);
			const context = programAnalysisContext(false);
			const report = new CoreOptimizationReportBuilder(program);
			const analyses = new CoreAnalysisManager(program, context, report);
			const pass = CORE_CONTROL_FLOW_PASSES.find(
				({ name }) => name === "dominance-redundancy-elimination",
			)!;
			new CoreFunctionPassScheduler(program, context, analyses, report, fn.id, {
				verification: "per-pass",
			}).runComponent("control-flow", [pass]);
			expect(fn.isInstructionLive(nestedValue.instruction)).toBe(false);
			for (const value of [dominating, leftValue, rightValue, joined, ...effects])
				expect(fn.isInstructionLive(value.instruction)).toBe(true);
		},
	);
});
