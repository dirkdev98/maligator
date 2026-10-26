import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { CORE_NO_EFFECTS } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import type { CoreFunctionPassContext } from "../src/compiler/core/core-pass.ts";
import {
	foldStaticBindingConstants,
	foldStaticPropertyReads,
	foldStaticReflections,
	selectStaticPropertyReads,
} from "../src/compiler/core/core-static-value-selection.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function scheduledStaticPasses() {
	const source = `const captured=globalThis.unknown;function observe(record,key){const value=record[key];const result=captured(record);return typeof value+result+captured;}globalThis.observe=observe;`;
	const { program, context } = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/entry.js", parseModule(source)),
		{ facts: programAnalysisContext().facts },
	);
	const fn = coreFunctionNamed(program, "observe")!;
	const report = new CoreOptimizationReportBuilder(program);
	const manager = new CoreAnalysisManager(program, context, report);
	const scheduler = new CoreFunctionPassScheduler(
		program,
		context,
		manager,
		report,
		fn.id,
		{ localOptimization: false },
	);
	const visits = new Set<string>();
	const passes = [
		selectStaticPropertyReads,
		foldStaticPropertyReads,
		foldStaticBindingConstants,
		foldStaticReflections,
	].map((pass) => ({
		...pass,
		run(context: CoreFunctionPassContext) {
			visits.add(pass.name);
			return pass.run(context);
		},
	}));
	scheduler.runComponent("memory", passes);
	expect(visits.size).toBe(passes.length);
	visits.clear();
	const call = coreOperations(fn).find(({ opcode }) => opcode === "call")!;
	return { program, fn, scheduler, visits, passes, call };
}

describe("static object pass scheduling", () => {
	it.each(["normal result", "unrelated metadata"])(
		"keeps descriptions quiescent after %s facts",
		(kind) => {
			const { program, fn, scheduler, visits, passes, call } = scheduledStaticPasses();
			const edit = CoreEditor.open(program, fn.id);
			if (kind === "normal result")
				edit.setNormalResultFacts(call.id, { mask: COMPILER_VALUE_KIND_NUMBER });
			else
				edit.addFact({
					kind: "unrelated-metadata",
					value: true,
					claims: [],
					validity: { kind: "summary", digest: "metadata" },
					obligations: [],
					origin: "test",
				});
			scheduler.runComponent("memory", passes, [edit.commit()]);
			expect(visits.size).toBe(0);
		},
	);

	it.each(["body", "effects", "program data"])(
		"revisits static descriptions after %s changes",
		(kind) => {
			const { program, fn, scheduler, visits, passes, call } = scheduledStaticPasses();
			const edit = CoreEditor.open(program, fn.id);
			if (kind === "body")
				edit.insertInstruction(fn.instructionBlock(call.id), call.id, "rootUse", [
					call.inputs[0]!,
				]);
			else if (kind === "program data") edit.appendStringConstants([[110, 101, 119]]);
			else {
				const proof = edit.addFact({
					kind: "call-effects",
					value: true,
					claims: [],
					validity: { kind: "summary", digest: "pure-call" },
					obligations: [],
					origin: "test",
				});
				edit.setInstructionEffectRefinement(call.id, {
					effects: CORE_NO_EFFECTS,
					proof,
				});
			}
			scheduler.runComponent("memory", passes, [edit.commit()]);
			expect(visits.size).toBe(passes.length);
		},
	);
});
