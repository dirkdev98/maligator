import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import type { CoreBlockId, CoreValueId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";
import { lowerExecutionFixtureToProgramImage } from "./helpers/native-program-image.ts";

function loopStorage({
	initial = 0,
	bound = 16,
	step = 1,
	accumulator = 0.5,
	handler = false,
	shared = false,
	unknown = false,
} = {}) {
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock(unknown ? [{ representation: "f64" }] : []);
	const literal = (value: number) =>
		builder.appendInstruction(entry, "createF64", [], {
			attributes: { value },
			outputRepresentations: ["f64"],
		})[0]!;
	const zero = literal(initial);
	const limit = unknown ? builder.blockParameterValue(entry, 0) : literal(bound);
	const sumInitial = accumulator === initial ? zero : literal(accumulator);
	const appendLoop = (
		preheader: CoreBlockId,
		start: CoreValueId,
		limit: CoreValueId,
		step: number,
		sum: CoreValueId,
	) => {
		const header = builder.createBlock([
			{ representation: "f64" },
			{ representation: "f64" },
		]);
		const body = builder.createBlock();
		const exit = builder.createBlock();
		const counter = builder.blockParameterValue(header, 0);
		const total = builder.blockParameterValue(header, 1);
		builder.setTerminator(preheader, {
			kind: "jump",
			edge: { block: header, arguments: [start, sum] },
		});
		const [condition] = builder.appendInstruction(header, "binary", [counter, limit], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [nextSum] = builder.appendInstruction(body, "binary", [total, counter], {
			attributes: { operator: "+" },
			outputRepresentations: ["f64"],
		});
		const [next] =
			step === 1
				? builder.appendInstruction(body, "unary", [counter], {
						attributes: { operator: "increment" },
						outputRepresentations: ["f64"],
					})
				: builder.appendInstruction(body, "binary", [counter, literal(step)], {
						attributes: { operator: "+" },
						outputRepresentations: ["f64"],
					});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [next!, nextSum!] },
		});
		if (handler) {
			const caught = builder.createBlock([
				{ role: "exception" },
				{ representation: "f64" },
				{ representation: "f64" },
			]);
			const caughtCounter = builder.blockParameterValue(caught, 1);
			builder.setHandler(exit, caught, [counter, start]);
			const [callee] = builder.appendInstruction(exit, "createUndefined", []);
			builder.appendInstruction(exit, "call", [callee!, callee!]);
			builder.setTerminator(caught, { kind: "return", value: caughtCounter });
		}
		return { counter, total, next: next!, nextSum: nextSum!, exit };
	};
	const first = appendLoop(entry, zero, limit, step, sumInitial);
	if (shared) {
		const second = appendLoop(first.exit, zero, literal(3.5), 0.5, first.total);
		builder.setTerminator(second.exit, { kind: "return", value: second.counter });
	} else builder.setTerminator(first.exit, { kind: "return", value: first.counter });
	const id = builder.finish(entry).function;
	const context = programAnalysisContext();
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	const pass = CORE_CONTROL_FLOW_PASSES.find(
		({ name }) => name === "loop-scalar-representation-selection",
	)!;
	new CoreFunctionPassScheduler(program, context, analyses, report, id, {
		verification: "per-pass",
	}).runComponent("control-flow", [pass]);
	verifyCoreProgram(program);
	const { summaries } = analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
	const plan = buildCoreOptimizationPlan(program, analyses, summaries, [id], {
		context,
		discoverCandidates: false,
	});
	const sealed = program.seal();
	const execution = lowerCoreCompilationToExecution({
		program: sealed,
		context,
		plan: verifyCoreOptimizationPlan(sealed, plan, context),
	});
	const image = lowerExecutionFixtureToProgramImage(execution);
	const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
	expect(restored).toEqual(image);
	expect(() => emitProgramImage(restored)).not.toThrow();
	return { fn: program.function(id), ...first, zero };
}

describe("loop scalar storage webs", () => {
	it.each([false, true])(
		"keeps integer induction storage independent of a floating sum, handler=%s",
		(handler) => {
			const out = loopStorage({ handler });
			for (const value of [out.counter, out.next])
				expect(out.fn.valueRepresentation(value)).toBe("i32");
			for (const value of [out.total, out.nextSum, out.zero])
				expect(out.fn.valueRepresentation(value)).toBe("f64");
		},
	);

	it("does not join independent integer and fractional loops through a shared zero", () => {
		const out = loopStorage({ shared: true, accumulator: 0 });
		expect(out.fn.valueRepresentation(out.counter)).toBe("i32");
		expect(out.fn.valueRepresentation(out.zero)).toBe("f64");
	});

	it.each([
		{ initial: 2147483646, bound: 2147483648 },
		{ initial: -0 },
		{ step: 0.5 },
		{ unknown: true },
	])("preserves floating induction storage for %j", (options) => {
		const out = loopStorage(options);
		expect(out.fn.valueRepresentation(out.counter)).toBe("f64");
		expect(out.fn.valueRepresentation(out.next)).toBe("f64");
	});
});
