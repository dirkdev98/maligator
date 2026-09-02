import { describe, expect, it } from "vitest";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_PROGRAM_FLOW_EFFECTS,
	CORE_PROGRAM_FLOW_RETURN_KIND,
	CoreProgramFlowEngine,
	coreProgramFlowDimensionsForDomains,
} from "../src/compiler/core/core-program-flow.ts";
import { CORE_PROGRAM_FLOW_MEMORY } from "../src/compiler/core/core-store.ts";
import {
	analysisProgram,
	appendLeaf,
} from "./helpers/core-program-analysis.ts";

describe("Core program flow", () => {
	it("deduplicates dirty functions within an immutable journal epoch", () => {
		const program = analysisProgram();
		const first = appendLeaf(program);
		appendLeaf(program);
		const flow = new CoreProgramFlowEngine(program).refresh();

		expect(flow.dirtyFunctionCount).toBe(2);
		const firstEdit = CoreEditor.open(program, first.function);
		firstEdit.configureFunction({ isAsync: true });
		firstEdit.commit();
		const secondEdit = CoreEditor.open(program, first.function);
		secondEdit.configureFunction({ isGenerator: true });
		secondEdit.commit();
		flow.refresh();

		expect(flow.dirtyFunctionCount).toBe(1);
		expect(flow.dirtyFunctionAt(0)).toBe(first.function);
	});

	it("does not wake value kinds for an effect-only change", () => {
		const dimensions = coreProgramFlowDimensionsForDomains(CORE_PROGRAM_FLOW_MEMORY);

		expect(dimensions & CORE_PROGRAM_FLOW_EFFECTS).toBe(CORE_PROGRAM_FLOW_EFFECTS);
		expect(dimensions & CORE_PROGRAM_FLOW_RETURN_KIND).toBe(0);
	});
});
