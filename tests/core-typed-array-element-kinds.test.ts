import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "../src/compiler/core/core-ir-value-kinds.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { constructSemanticProgramCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";

// `numbered` reads with a Number key, `named` with a key of unknown kind.
const source = `
	function numbered(table, index) { return table[index | 0]; }
	function named(table, name) { return table[name]; }
	function unproven(table, index) { return table[index | 0]; }
	globalThis.readers = [numbered, named, unproven];`;

// Memory planning records a proven receiver kind on the load, as these readers' callers would.
const PROVEN_RECEIVERS = new Set(["numbered", "named"]);

function keyedLoadKinds(): Map<string, number> {
	const core = constructSemanticProgramCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/typed-elements.js"),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: "locked", eval: false } }),
			),
		},
		(_phase, run) => run(),
	);
	const analyses = new CoreAnalysisManager(
		core.program,
		core.context,
		new CoreOptimizationReportBuilder(core.program),
	);
	const kinds = new Map<string, number>();
	for (const id of core.program.functionIds()) {
		const fn = core.program.function(id);
		const units = core.program.stringConstants[fn.metadata.nameStringIndex];
		const name = units === undefined ? undefined : String.fromCharCode(...units);
		if (name === undefined) continue;
		const keyedLoads = () =>
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadProperty",
			);
		if (PROVEN_RECEIVERS.has(name)) {
			const editor = CoreEditor.open(core.program, id);
			for (const load of keyedLoads()) {
				const operandStart = fn.kernel.instructionOperandStart(load);
				editor.replaceInstruction(
					load,
					"loadProperty",
					Array.from({ length: fn.kernel.instructionOperandCount(load) }, (_, index) =>
						fn.kernel.operandAt(operandStart + index),
					),
					{
						attributes: {
							...fn.instructionAttributes(load),
							[CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE]: "Float64Array",
						},
					},
				);
			}
			editor.commit();
		}
		const local = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
			scope: "function",
			function: id,
		});
		for (const load of keyedLoads())
			kinds.set(
				name,
				local.kindMask(fn.kernel.resultAt(fn.kernel.instructionResultStart(load))),
			);
	}
	return kinds;
}

describe("typed array element kinds", () => {
	it("give a Number-keyed read of a proven numeric TypedArray its element kind", () => {
		expect(keyedLoadKinds().get("numbered")).toBe(
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED,
		);
	});

	it("leave other keys and unproven receivers unknown", () => {
		const kinds = keyedLoadKinds();
		expect(kinds.get("named")).toBe(COMPILER_VALUE_KIND_TOP);
		expect(kinds.get("unproven")).toBe(COMPILER_VALUE_KIND_TOP);
	});
});
