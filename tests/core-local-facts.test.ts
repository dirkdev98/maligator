import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CORE_LOCAL_FACT_BUNDLE_ANALYSIS } from "../src/compiler/core/core-ir-provenance.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

describe("Core local fact bundle", () => {
	it("invalidates structural projections only for their actual inputs", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const allocation = builder.appendInstruction(entry, "createArray", [], {
			attributes: { length: 0 },
		})[0]!;
		const instruction = builder.bodyInstructionIds(entry)[0]!;
		builder.setTerminator(entry, { kind: "return", value: allocation });
		const fn = program.function(builder.finish(entry).function);
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, programAnalysisContext(), report);
		const request = { scope: "function", function: fn.id } as const;
		let bundle = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request);
		for (const kind of ["representations", "effects", "data", "body"] as const) {
			const index = bundle.index;
			const provenance = bundle.provenance;
			const editor = CoreEditor.open(program, fn.id);
			if (kind === "representations")
				editor.setValueRepresentation(allocation, "scalarized-object");
			else if (kind === "data") editor.appendStringConstants([[97]]);
			else if (kind === "body")
				editor.appendInstruction(entry, "createNumber", [], { attributes: { value: 1 } });
			else {
				const effects = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
				const proof = editor.addFact({
					kind: "projection-effect-test",
					value: true,
					claims: [{ kind: "effect", instruction, effects }],
					validity: { kind: "summary", digest: "projection-effect-test" },
					obligations: [],
					origin: "test",
				});
				editor.setInstructionEffectRefinement(instruction, { effects, proof });
			}
			editor.commit();
			const next = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request);
			expect(next === bundle, kind).toBe(false);
			expect(next.index === index).toBe(kind === "representations" || kind === "data");
			expect(next.provenance === provenance, kind).toBe(false);
			expect(() => provenance.cannotBeHeldWeakly(allocation)).toThrow(
				"Stale allocation provenance analysis",
			);
			bundle = next;
		}
		expect(bundle.index.operations).toHaveLength(2);
	});

	it("shares one bundle across local consumers and invalidates only its function", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const allocationBuilder = new CoreFunctionBuilder(program);
		const allocationEntry = allocationBuilder.createBlock();
		const [allocation] = allocationBuilder.appendInstruction(
			allocationEntry,
			"createArray",
			[],
			{ attributes: { length: 0 } },
		);
		allocationBuilder.setTerminator(allocationEntry, {
			kind: "return",
			value: allocation!,
		});
		const allocationFunction = allocationBuilder.finish(allocationEntry).function;

		const unrelatedBuilder = new CoreFunctionBuilder(program);
		const unrelatedEntry = unrelatedBuilder.createBlock();
		const [unrelatedValue] = unrelatedBuilder.appendInstruction(
			unrelatedEntry,
			"createNumber",
			[],
			{ attributes: { value: 1 } },
		);
		unrelatedBuilder.setTerminator(unrelatedEntry, {
			kind: "return",
			value: unrelatedValue!,
		});
		const unrelatedFunction = unrelatedBuilder.finish(unrelatedEntry).function;

		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, programAnalysisContext(), report);
		const request = { scope: "function" as const, function: allocationFunction };
		const first = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request);
		expect(first.index.operations).toHaveLength(1);
		expect(first.provenance.layouts).toHaveLength(1);
		expect(first.valueKinds.kindMask(allocation!)).not.toBe(0);
		expect(first.valueClasses.exactHeapBrand(allocation!)).toBe("Array");
		expect(analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request)).toBe(first);

		const unrelatedEditor = CoreEditor.open(program, unrelatedFunction);
		unrelatedEditor.setValueRepresentation(unrelatedValue!, "i32");
		unrelatedEditor.commit();
		expect(analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request)).toBe(first);

		const allocationEditor = CoreEditor.open(program, allocationFunction);
		allocationEditor.setValueRepresentation(allocation!, "scalarized-object");
		allocationEditor.commit();
		const rebuilt = analyses.get(CORE_LOCAL_FACT_BUNDLE_ANALYSIS, request);
		expect(rebuilt).not.toBe(first);
		expect(rebuilt.index.operations).toHaveLength(1);

		const finished = report.finish(program, {
			directEntries: [],
			specializations: [],
		});
		expect(finished.counters.localFactRebuilds).toBe(2);
	});
});
