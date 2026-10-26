import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import type { CoreRepresentation, CoreValueId } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";
import { lowerExecutionFixtureToProgramImage } from "./helpers/native-program-image.ts";

function component(
	left: number,
	right: number,
	{ integerLeft = false, handler = false } = {},
) {
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const branches = [builder.createBlock(), builder.createBlock()] as const;
	const join = builder.createBlock();
	const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: branches[0], arguments: [] },
		alternate: { block: branches[1], arguments: [] },
	});
	const producers: Array<CoreValueId> = [];
	for (const [index, value] of [left, right].entries()) {
		const block = branches[index]!;
		const integer = index === 0 && integerLeft;
		const [number] = builder.appendInstruction(
			block,
			integer ? "createNumber" : "createF64",
			[],
			{
				attributes: { value },
				outputRepresentations: [integer ? "i32" : "f64"],
			},
		);
		producers.push(number!);
		const [boxed] = builder.appendInstruction(block, "move", [number!]);
		builder.setTerminator(block, {
			kind: "jump",
			edge: { block: join, arguments: [boxed!] },
		});
	}
	const joined = builder.appendBlockParameter(join);
	const observed = [joined];
	const finish = (block: typeof join, value: CoreValueId) => {
		const [result] = builder.appendInstruction(block, "unary", [value], {
			attributes: { operator: "~" },
		});
		builder.setTerminator(block, { kind: "return", value: result! });
	};
	if (handler) {
		const caught = builder.createBlock([{ role: "exception" }, {}]);
		const local = builder.blockParameterValue(caught, 1);
		observed.push(local);
		builder.setHandler(join, caught, [joined]);
		const [callee] = builder.appendInstruction(join, "createUndefined", []);
		builder.appendInstruction(join, "call", [callee!, callee!]);
		finish(caught, local);
	}
	finish(join, joined);
	const id = builder.finish(entry).function;
	const context = programAnalysisContext();
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	const pass = CORE_PROOF_PASSES.find(
		({ name }) => name === "flow-scalar-representation-selection",
	)!;
	new CoreFunctionPassScheduler(program, context, analyses, report, id, {
		verification: "per-pass",
	}).runComponent("proofs", [pass]);
	return { program, context, analyses, id, producers, observed };
}

function lower(out: ReturnType<typeof component>) {
	const { program, context, analyses, id } = out;
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
	return lowerExecutionFixtureToProgramImage(execution);
}

describe("atomic scalar flow representations", () => {
	it.each([false, true])(
		"narrows the complete exact-int32 component before target lowering, handler=%s",
		(handler) => {
			for (const [left, right] of [
				[7, 3],
				[-2147483648, 2147483647],
			]) {
				const out = component(left!, right!, { handler });
				const fn = out.program.function(out.id);
				for (const value of [...out.producers, ...out.observed])
					expect(fn.valueRepresentation(value)).toBe("i32");
				const image = lower(out);
				const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
				expect(restored).toEqual(image);
				expect(() => emitProgramImage(restored)).not.toThrow();
			}
		},
	);

	it.each([
		[-0, 0],
		[2147483648, 1],
		[-2147483649, 1],
		[1.5, 2],
		[NaN, 1],
		[Infinity, -Infinity],
	])("keeps %s and %s in floating storage", (left, right) => {
		const out = component(left, right);
		const fn = out.program.function(out.id);
		for (const value of [...out.producers, ...out.observed])
			expect(fn.valueRepresentation(value)).toBe("f64");
		expect(() => lower(out)).not.toThrow();
	});

	it("preserves an existing integer producer when the component needs numeric widening", () => {
		const out = component(7, 1.5, { integerLeft: true });
		const fn = out.program.function(out.id);
		expect(fn.valueRepresentation(out.producers[0]!)).toBe("i32");
		expect(fn.valueRepresentation(out.producers[1]!)).toBe("f64");
		expect(fn.valueRepresentation(out.observed[0]!)).toBe("f64");
		expect(() => lower(out)).not.toThrow();
	});

	it.each([
		["f64", "i32"],
		["boolean", "f64"],
		["i32", "boolean"],
		["string", "f64"],
		["f64", "string"],
	] satisfies Array<[CoreRepresentation, CoreRepresentation]>)(
		"rejects an implicit %s to %s conversion at the Core boundary",
		(source, destination) => {
			const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const opcode =
				source === "string"
					? "createString"
					: source === "boolean"
						? "createBoolean"
						: source === "i32"
							? "createNumber"
							: "createF64";
			const [value] = builder.appendInstruction(entry, opcode, [], {
				attributes:
					source === "string"
						? { stringIndex: 0 }
						: { value: source === "boolean" ? true : 1 },
				outputRepresentations: [source],
			});
			const [moved] = builder.appendInstruction(entry, "move", [value!], {
				outputRepresentations: [destination],
			});
			builder.setTerminator(entry, { kind: "return", value: moved! });
			builder.finish(entry);
			expect(() => verifyCoreProgram(program)).toThrow(
				/move .* changes .* representation/,
			);
		},
	);
});
