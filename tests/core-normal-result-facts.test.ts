import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS } from "../src/compiler/core/core-ir-interprocedural-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "../src/compiler/core/core-ir-loops.ts";
import { CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS } from "../src/compiler/core/core-ir-memory.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "../src/compiler/core/core-ir-provenance.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-ir-value-kinds.ts";
import { CORE_NO_EFFECTS } from "../src/compiler/core/core-ir.ts";
import { CORE_MEMORY_PASSES } from "../src/compiler/core/core-memory-passes.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import {
	CORE_PROGRAM_FLOW_ANALYSIS,
	CORE_PROGRAM_VALUE_KIND_ANALYSIS,
} from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { COMPILER_INT32_RANGE } from "../src/compiler/shared/integer-range.ts";
import {
	analysisProgram,
	appendCaller,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

function observedResult(kind: "call" | "field") {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
	const entry = builder.createBlock([{}, {}]);
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	const [value] = builder.appendInstruction(
		entry,
		kind === "call" ? "call" : "loadPropertyStatic",
		kind === "call"
			? [builder.blockParameterValue(entry, 1), receiver!]
			: [builder.blockParameterValue(entry, 0)],
		{
			attributes:
				kind === "call" ? { marker: "kept" } : { stringIndex: 0, marker: "kept" },
		},
	);
	const instruction = builder.bodyInstructionIds(entry).at(-1)!;
	builder.setTerminator(entry, { kind: "return", value: value! });
	const fn = program.function(builder.finish(entry).function);
	const report = new CoreOptimizationReportBuilder(program);
	const manager = new CoreAnalysisManager(program, programAnalysisContext(false), report);
	return { program, fn, manager, report, value: value!, instruction };
}

const bounded = { ...COMPILER_INT32_RANGE, minimum: 0, maximum: 255 };

describe("normal-result fact publication", () => {
	it.each(["call", "construct"])(
		"withdraws receiver dispatch when a %s result brand is withdrawn",
		(completion) => {
			const { program, fn, manager, report, instruction, value } = observedResult("call");
			const block = fn.instructionBlock(instruction);
			const edit = CoreEditor.open(program, fn.id);
			if (completion === "construct")
				edit.replaceInstruction(instruction, "construct", [
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
				]);
			edit.setNormalResultFacts(instruction, {
				mask: COMPILER_VALUE_KIND_OBJECT,
				heapBrand: "Map",
			});
			const has = edit.insertInstruction(
				block,
				fn.blockTerminator(block),
				"callKnown",
				[value],
				{ attributes: { operation: "Map.prototype.has" } },
			);
			edit.replaceTerminator(block, { kind: "return", value: has.outputs[0]! });
			edit.commit();
			const scheduler = new CoreFunctionPassScheduler(
				program,
				programAnalysisContext(false),
				manager,
				report,
				fn.id,
			);
			const passes = CORE_MEMORY_PASSES.filter(
				(pass) => pass.name === "refine-exact-collection-accesses",
			);
			scheduler.runComponent("memory", passes);
			expect(fn.instructionAttributes(has.instruction).specialized).toBe(
				"Map.prototype.has",
			);
			const clear = CoreEditor.open(program, fn.id);
			clear.setNormalResultFacts(instruction, { mask: COMPILER_VALUE_KIND_OBJECT });
			scheduler.runComponent("memory", passes, [clear.commit()]);
			expect(fn.instructionAttributes(has.instruction).specialized).toBeUndefined();
			expect(
				fn.instructionAttributes(has.instruction).exactCollectionReceiver,
			).toBeUndefined();
			expect(fn.instructionEffectRefinement(has.instruction)).toBeUndefined();
		},
	);

	it("keeps brand publication independent of effect proofs and validates its kind", () => {
		const { program, fn, instruction } = observedResult("call");
		const edit = CoreEditor.open(program, fn.id);
		expect(() =>
			edit.setNormalResultFacts(instruction, {
				mask: COMPILER_VALUE_KIND_NUMBER,
				heapBrand: "Map",
			}),
		).toThrow("Invalid normal-result facts");
		const proof = edit.addFact({
			kind: "effect-only",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "effect-only" },
			obligations: [],
			origin: "test",
		});
		edit.setInstructionEffectRefinement(instruction, { effects: CORE_NO_EFFECTS, proof });
		edit.setNormalResultFacts(instruction, {
			mask: COMPILER_VALUE_KIND_OBJECT,
			heapBrand: "Map",
		});
		edit.commit();
		expect(fn.instructionEffectRefinement(instruction)?.proof).toBe(proof);
	});

	it("keeps an existing effect proof when publishing field bounds", () => {
		const { program, fn, instruction } = observedResult("field");
		const prove = CoreEditor.open(program, fn.id);
		const proof = prove.addFact({
			kind: "effect-only",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "effect-only" },
			obligations: [],
			origin: "test",
		});
		prove.setInstructionEffectRefinement(instruction, {
			effects: CORE_NO_EFFECTS,
			proof,
		});
		prove.commit();
		const refinement = fn.instructionEffectRefinement(instruction);
		const edit = CoreEditor.open(program, fn.id);
		edit.setNormalResultFacts(instruction, {
			mask: COMPILER_VALUE_KIND_NUMBER,
			integerRange: bounded,
		});
		edit.commit();
		expect(fn.instructionEffectRefinement(instruction)).toBe(refinement);
	});

	it("rejects unknown masks and bounds that do not describe integer Numbers", () => {
		const { program, fn, instruction } = observedResult("field");
		const edit = CoreEditor.open(program, fn.id);
		for (const facts of [
			{ mask: 0 },
			{ mask: COMPILER_VALUE_KIND_TOP },
			{ mask: COMPILER_VALUE_KIND_NUMBER, integerRange: { ...bounded, minimum: 256 } },
		])
			expect(() => edit.setNormalResultFacts(instruction, facts)).toThrow(
				"Invalid normal-result facts",
			);
		expect(edit.commit().edits).toBe(0);
	});

	it("wakes range folding from a field proof without a body edit", () => {
		const { program, fn, manager, value, instruction } = observedResult("field");
		const block = fn.instructionBlock(instruction);
		const prepare = CoreEditor.open(program, fn.id);
		const limit = prepare.insertInstruction(
			block,
			fn.blockTerminator(block),
			"createNumber",
			[],
			{ attributes: { value: 256 } },
		).outputs[0]!;
		const compare = prepare.insertInstruction(
			block,
			fn.blockTerminator(block),
			"binary",
			[value, limit],
			{ attributes: { operator: "<" } },
		);
		prepare.replaceTerminator(block, { kind: "return", value: compare.outputs[0]! });
		prepare.commit();
		const report = new CoreOptimizationReportBuilder(program);
		const scheduler = new CoreFunctionPassScheduler(
			program,
			programAnalysisContext(false),
			manager,
			report,
			fn.id,
		);
		const passes = CORE_CONTROL_FLOW_PASSES.filter(
			({ name }) => name === "path-range-control-folding",
		);
		scheduler.runComponent("control-flow", passes);
		expect(fn.instructionOpcodeName(compare.instruction)).toBe("binary");
		const edit = CoreEditor.open(program, fn.id);
		edit.setNormalResultFacts(instruction, {
			mask: COMPILER_VALUE_KIND_NUMBER,
			integerRange: bounded,
		});
		scheduler.runComponent("control-flow", passes, [edit.commit()]);
		expect(fn.instructionOpcodeName(compare.instruction)).toBe("createBoolean");
		expect(fn.instructionAttributes(compare.instruction).value).toBe(true);
	});

	it.each(["call", "field"] as const)("changes only fact versions for a %s", (kind) => {
		const { program, fn, value, instruction } = observedResult(kind);
		const before = fn.versions;
		const featureVersion = fn.featureVersion;
		const operands = fn.kernel.instructionOperandStart(instruction);
		const sourcePosition = fn.instructionSourcePosition(instruction);
		const range = { ...bounded };
		const edit = CoreEditor.open(program, fn.id);
		edit.setNormalResultFacts(instruction, {
			mask: COMPILER_VALUE_KIND_NUMBER,
			integerRange: range,
		});
		const changes = edit.commit();
		expect(changes.domains).toEqual(["facts", "normalResults", "specializationInputs"]);
		expect(changes.values).toEqual([value]);
		expect(fn.versions).toEqual({
			...before,
			facts: before.facts + 1,
			normalResults: before.normalResults + 1,
			specializationInputs: before.specializationInputs + 1,
		});
		expect(fn.featureVersion).toBe(featureVersion);
		expect(fn.kernel.instructionOperandStart(instruction)).toBe(operands);
		expect(fn.instructionSourcePosition(instruction)).toBe(sourcePosition);
		expect(fn.instructionAttributes(instruction).marker).toBe("kept");
		range.minimum = 15;
		expect(fn.instructionAttributes(instruction).normalResultIntegerRange).toEqual(
			bounded,
		);
		const same = CoreEditor.open(program, fn.id);
		same.setNormalResultFacts(instruction, {
			mask: COMPILER_VALUE_KIND_NUMBER,
			integerRange: bounded,
		});
		expect(same.commit().edits).toBe(0);
		const clear = CoreEditor.open(program, fn.id);
		clear.setNormalResultFacts(instruction, undefined);
		expect(clear.commit().domains).toEqual([
			"facts",
			"normalResults",
			"specializationInputs",
		]);
		expect(fn.instructionAttributes(instruction)).toEqual(
			kind === "call" ? { marker: "kept" } : { stringIndex: 0, marker: "kept" },
		);
	});

	it.each(["call", "field"] as const)(
		"refreshes value consumers while retaining %s structure and memory",
		(kind) => {
			const { program, fn, manager, report, value, instruction } = observedResult(kind);
			const request = { scope: "function", function: fn.id } as const;
			const control = manager.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request);
			const cfg = control.exceptional();
			const roots = manager.get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request);
			const calls = manager.get(CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS, request);
			const kinds = manager.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request);
			const ranges = manager.get(CORE_LOOP_INDUCTION_ANALYSIS, request);
			const bundle = manager.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request);
			const index = bundle.index;
			const provenance = bundle.provenance;
			const memory = manager.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request);
			memory.readHash(instruction);
			expect(kinds.kindMask(value)).toBe(COMPILER_VALUE_KIND_TOP);
			expect(ranges.range(value)).toBeUndefined();
			expect(bundle.valueKinds.kindMask(value)).toBe(COMPILER_VALUE_KIND_TOP);
			const edit = CoreEditor.open(program, fn.id);
			edit.setNormalResultFacts(instruction, {
				mask: COMPILER_VALUE_KIND_NUMBER,
				integerRange: bounded,
			});
			edit.commit();
			expect(manager.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request)).toBe(control);
			expect(control.exceptional()).toBe(cfg);
			expect(manager.get(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS, request)).toBe(roots);
			expect(manager.get(CORE_LOCAL_INTERPROCEDURAL_FLOW_ANALYSIS, request)).toBe(calls);
			expect(manager.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request).kindMask(value)).toBe(
				COMPILER_VALUE_KIND_NUMBER,
			);
			expect(manager.get(CORE_LOOP_INDUCTION_ANALYSIS, request).range(value)).toEqual(
				bounded,
			);
			expect(
				manager.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request).valueKinds.kindMask(value),
			).toBe(COMPILER_VALUE_KIND_NUMBER);
			expect(manager.get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request)).toBe(memory);
			expect(manager.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request).index).toBe(index);
			expect(manager.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request).provenance).toBe(
				provenance,
			);
			expect(() => memory.readHash(instruction)).not.toThrow();
			const counters = report.finish(program, {
				directEntries: [],
				specializations: [],
			}).counters;
			expect(counters.localFactRebuilds).toBe(2);
			expect(counters.provenanceRebuilds).toBe(1);
		},
	);

	it("propagates fact-only return-kind changes through cached call edges", () => {
		const { program, fn, manager, instruction } = observedResult("call");
		const caller = appendCaller(program, fn.id);
		const before = manager.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
		const kinds = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;
		expect(kinds.summary(caller.function).returnKind).toBe(COMPILER_VALUE_KIND_TOP);
		const edit = CoreEditor.open(program, fn.id);
		edit.setNormalResultFacts(instruction, { mask: COMPILER_VALUE_KIND_NUMBER });
		edit.commit();
		const after = manager.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
		expect(after.targets).toBe(before.targets);
		expect(after.summaries).toBe(before.summaries);
		expect(after.reachability).toBe(before.reachability);
		const refreshed = manager.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		}).kinds;
		expect(refreshed.summary(fn.id).returnKind).toBe(COMPILER_VALUE_KIND_NUMBER);
		expect(refreshed.summary(caller.function).returnKind).toBe(
			COMPILER_VALUE_KIND_NUMBER,
		);
		const clear = CoreEditor.open(program, fn.id);
		clear.setNormalResultFacts(instruction, undefined);
		clear.commit();
		expect(
			manager
				.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" })
				.kinds.summary(caller.function).returnKind,
		).toBe(COMPILER_VALUE_KIND_TOP);
	});
});
