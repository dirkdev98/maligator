import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { pruneCoreCaptureLiveness } from "../src/compiler/core/core-capture-liveness.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	analysisProgram,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

describe("Core capture liveness", () => {
	it.each([false, true])(
		"discards cross-block definitions and handler arguments with reverse storage order %s",
		(reverse) => {
			const program = analysisProgram();
			const live = appendLeaf(program);
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const first = builder.createBlock();
			const second = builder.createBlock();
			const producer = reverse ? second : first;
			const consumer = reverse ? first : second;
			const handler = builder.createBlock([{ role: "exception" }, {}]);
			const [value] = builder.appendInstruction(producer, "createUndefined", []);
			const [callee] = builder.appendInstruction(consumer, "createUndefined", []);
			builder.appendInstruction(consumer, "call", [callee!, value!]);
			builder.setHandler(consumer, handler, [value!]);
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: producer, arguments: [] },
			});
			builder.setTerminator(producer, {
				kind: "jump",
				edge: { block: consumer, arguments: [] },
			});
			builder.setTerminator(consumer, { kind: "return", value: value! });
			builder.setTerminator(handler, {
				kind: "return",
				value: builder.blockParameterValue(handler, 1),
			});
			builder.finish(entry);
			verifyCoreProgram(program);
			const context = programAnalysisContext();
			const manager = new CoreAnalysisManager(
				program,
				context,
				new CoreOptimizationReportBuilder(program),
			);
			const flow = manager.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });

			pruneCoreCaptureLiveness(program, context, flow);

			verifyCoreProgram(program);
			const discarded = program.function(builder.functionId);
			expect([...discarded.blockIds()]).toEqual([entry]);
			expect(
				discarded.instructionOpcodeName([...discarded.bodyInstructionIds(entry)][0]!),
			).toBe("createUndefined");
			expect(
				program.function(live.function).instructionOpcodeName(live.valueInstruction),
			).toBe("createUndefined");
		},
	);
});
