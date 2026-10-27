import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreValueKinds } from "../src/compiler/core/core-ir-value-kinds.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { constructSemanticProgramCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { COMPILER_VALUE_KIND_OBJECT } from "../src/compiler/shared/compiler-value-kinds.ts";

const source = `
	function Point(x) { this.x = x; return 7; }
	function make(parts) {
		return [new Uint32Array(16), new Point(1), new Point(...parts)];
	}
	globalThis.made = make([2]);`;

function constructionKinds(): Array<number> {
	const core = constructSemanticProgramCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/construct.js"),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: "locked", eval: false } }),
			),
		},
		(_phase, run) => run(),
	);
	const masks: Array<number> = [];
	for (const id of core.program.functionIds()) {
		const fn = core.program.function(id);
		const kinds = analyzeCoreValueKinds(
			core.program,
			fn,
			buildCoreControlFlow(core.program, id),
		);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "construct" && opcode !== "constructSpread") continue;
			masks.push(
				kinds.kindMask(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction))),
			);
		}
	}
	return masks;
}

describe("construction kinds", () => {
	it("type every construct result as an object, whatever the constructor returns", () => {
		const masks = constructionKinds();
		expect(masks.length).toBeGreaterThanOrEqual(3);
		for (const mask of masks) expect(mask).toBe(COMPILER_VALUE_KIND_OBJECT);
	});
});
