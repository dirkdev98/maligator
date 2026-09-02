import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreLoopInductions } from "../src/compiler/core/core-ir-loops.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";
import { coreFunctionNamed } from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

interface BoundedFunction {
	readonly program: CoreProgram;
	readonly function: CoreFunctionId;
	readonly value: CoreValueId;
	readonly bounded: CoreBlockId;
}

function boundedInt32(polarity: "consequent" | "alternate"): BoundedFunction {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{}]);
	const lower = builder.createBlock();
	const bounded = builder.createBlock();
	const rejected = builder.createBlock();
	const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
	const [value] = builder.appendInstruction(entry, "unary", [parameter], {
		attributes: { operator: "~" },
		outputRepresentations: ["i32"],
	});
	const [zero] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 0 },
		outputRepresentations: ["i32"],
	});
	const [sixteen] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 16 },
		outputRepresentations: ["i32"],
	});
	const [lowerCondition] = builder.appendInstruction(
		entry,
		"binary",
		polarity === "consequent" ? [value!, zero!] : [zero!, value!],
		{
			attributes: { operator: polarity === "consequent" ? ">=" : ">" },
			outputRepresentations: ["boolean"],
		},
	);
	builder.setTerminator(entry, {
		kind: "branch",
		condition: lowerCondition!,
		consequent: {
			block: polarity === "consequent" ? lower : rejected,
			arguments: [],
		},
		alternate: {
			block: polarity === "consequent" ? rejected : lower,
			arguments: [],
		},
	});
	const [upperCondition] = builder.appendInstruction(
		lower,
		"binary",
		polarity === "consequent" ? [value!, sixteen!] : [sixteen!, value!],
		{
			attributes: { operator: polarity === "consequent" ? "<" : "<=" },
			outputRepresentations: ["boolean"],
		},
	);
	builder.setTerminator(lower, {
		kind: "branch",
		condition: upperCondition!,
		consequent: {
			block: polarity === "consequent" ? bounded : rejected,
			arguments: [],
		},
		alternate: {
			block: polarity === "consequent" ? rejected : bounded,
			arguments: [],
		},
	});
	const [remainder] = builder.appendInstruction(bounded, "binary", [value!, sixteen!], {
		attributes: { operator: "%" },
		outputRepresentations: ["i32"],
	});
	builder.setTerminator(bounded, { kind: "return", value: remainder! });
	builder.setTerminator(rejected, { kind: "return", value: zero! });
	const finished = builder.finish(entry);
	return { program, function: finished.function, value: value!, bounded };
}

function binaryOperators(fn: CoreFunctionStore): ReadonlyArray<unknown> {
	return [...fn.blockIds()].flatMap((block) =>
		[...fn.bodyInstructionIds(block)]
			.filter((instruction) => fn.instructionOpcodeName(instruction) === "binary")
			.map((instruction) => fn.instructionAttributes(instruction).operator),
	);
}

function pathRanges(source: BoundedFunction) {
	const fn = source.program.function(source.function);
	const cfg = buildCoreControlFlow(source.program, source.function);
	return analyzeCoreLoopInductions(fn, cfg, coreCanonicalValueRoots(fn, cfg));
}

describe("Core path-sensitive numeric ranges", () => {
	it("folds comparisons from reusable int32 representation ranges", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{ representation: "i32" }]);
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [first] = builder.appendInstruction(left, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["i32"],
		});
		const [second] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 2 },
			outputRepresentations: ["i32"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [first!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [second!] },
		});
		const value = inspectCoreBlockParameters(builder, join)[0]!.value;
		const [limit] = builder.appendInstruction(join, "createF64", [], {
			attributes: { value: 0x8000_0000 },
			outputRepresentations: ["f64"],
		});
		const [comparison] = builder.appendInstruction(join, "binary", [value, limit!], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(join, { kind: "return", value: comparison! });
		const finished = builder.finish(entry);
		const source = { program, function: finished.function, value, bounded: join };
		expect(pathRanges(source).range(value, join)).toEqual({
			minimum: -0x8000_0000,
			maximum: 0x7fff_ffff,
			exactSafeIntegers: true,
			excludesNegativeZero: true,
		});
		expect(binaryOperators(program.function(finished.function))).toContain("<");
		const fn = optimizeCore(
			{ program, context: programAnalysisContext() },
			{ verification: "per-pass" },
		).compilation.program.function(finished.function);
		expect(binaryOperators(fn)).not.toContain("<");
		const returnBlock = [...fn.blockIds()].find(
			(block) =>
				inspectCoreTerminatorPayload(fn, fn.blockTerminator(block)).kind === "return",
		);
		expect(returnBlock).toBeDefined();
		const returned = inspectCoreTerminatorPayload(fn, fn.blockTerminator(returnBlock!));
		if (returned.kind !== "return") throw new Error("expected return");
		const definition = inspectCoreValueDefinition(fn, returned.value);
		if (definition.kind !== "instruction") throw new Error("expected constant result");
		expect(fn.instructionOpcodeName(definition.instruction)).toBe("createBoolean");
		expect(fn.instructionAttributes(definition.instruction).value).toBe(true);
	});

	it.each(["consequent", "alternate"] as const)(
		"intersects %s-edge int32 bounds and removes a dominated remainder",
		(polarity) => {
			const source = boundedInt32(polarity);
			expect(pathRanges(source).range(source.value, source.bounded)).toEqual({
				minimum: 0,
				maximum: 15,
				exactSafeIntegers: true,
				excludesNegativeZero: true,
			});
			expect(binaryOperators(source.program.function(source.function))).toContain("%");
			const outcome = optimizeCore(
				{ program: source.program, context: programAnalysisContext() },
				{ verification: "per-pass", instrumentation: "full" },
			);
			const optimized = outcome.compilation.program.function(source.function);
			expect(
				outcome.report.passes.find(
					({ pass }) => pass === "path-range-strength-reduction",
				),
			).toMatchObject({ changedItems: 1 });
			expect(binaryOperators(optimized)).not.toContain("%");
		},
	);

	it("consumes a branch-narrowed induction range in source Core", () => {
		let consequent: CoreFunctionStore | undefined;
		let alternate: CoreFunctionStore | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function consequent() {
					let total = 0;
					for (let index = 0; index < 32; index++) {
						if (index < 16) total += index % 16;
					}
					return total;
				}
				function alternate() {
					let total = 0;
					for (let index = 0; index < 32; index++) {
						if (index >= 16) continue;
						total += index % 16;
					}
					return total;
				}
				globalThis.result = consequent() + alternate();`,
				"numeric-branch-range-source.js",
			),
			{
				afterCoreOptimization(program) {
					consequent = coreFunctionNamed(program, "consequent");
					alternate = coreFunctionNamed(program, "alternate");
				},
			},
		);
		expect(consequent).toBeDefined();
		expect(alternate).toBeDefined();
		expect(binaryOperators(consequent!)).not.toContain("%");
		expect(binaryOperators(alternate!)).not.toContain("%");
	});

	it("drops edge refinements when opposite arms rejoin", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const consequent = builder.createBlock();
		const alternate = builder.createBlock();
		const join = builder.createBlock();
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [value] = builder.appendInstruction(entry, "unary", [parameter], {
			attributes: { operator: "~" },
			outputRepresentations: ["i32"],
		});
		const [zero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["i32"],
		});
		const [sixteen] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 16 },
			outputRepresentations: ["i32"],
		});
		const [condition] = builder.appendInstruction(entry, "binary", [value!, zero!], {
			attributes: { operator: ">=" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: consequent, arguments: [] },
			alternate: { block: alternate, arguments: [] },
		});
		builder.setTerminator(consequent, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		builder.setTerminator(alternate, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		const [remainder] = builder.appendInstruction(join, "binary", [value!, sixteen!], {
			attributes: { operator: "%" },
			outputRepresentations: ["i32"],
		});
		builder.setTerminator(join, { kind: "return", value: remainder! });
		const finished = builder.finish(entry);
		const source = { program, function: finished.function, value: value!, bounded: join };
		const analysis = pathRanges(source);
		expect(analysis.range(value!, consequent)).toMatchObject({ minimum: 0 });
		expect(analysis.range(value!, alternate)).toMatchObject({ maximum: -1 });
		expect(analysis.range(value!, join)).toMatchObject({
			minimum: -0x8000_0000,
			maximum: 0x7fff_ffff,
		});
		const optimized = optimizeCore(
			{ program, context: programAnalysisContext() },
			{ verification: "per-pass" },
		).compilation.program.function(finished.function);
		expect(binaryOperators(optimized)).toContain("%");
	});

	it.each(["f64", "boxed"] as const)(
		"does not turn %s comparison bounds into an exact-integer proof",
		(representation) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{}]);
			const lower = builder.createBlock();
			const bounded = builder.createBlock();
			const rejected = builder.createBlock();
			const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const value =
				representation === "boxed"
					? parameter
					: builder.appendInstruction(entry, "unary", [parameter], {
							attributes: { operator: "+" },
							outputRepresentations: ["f64"],
						})[0]!;
			const constantOpcode = representation === "boxed" ? "createNumber" : "createF64";
			const [zero] = builder.appendInstruction(entry, constantOpcode, [], {
				attributes: { value: 0 },
				outputRepresentations: [representation],
			});
			const [sixteen] = builder.appendInstruction(entry, constantOpcode, [], {
				attributes: { value: 16 },
				outputRepresentations: [representation],
			});
			const [lowerCondition] = builder.appendInstruction(
				entry,
				"binary",
				[value, zero!],
				{
					attributes: { operator: ">=" },
					outputRepresentations: ["boolean"],
				},
			);
			builder.setTerminator(entry, {
				kind: "branch",
				condition: lowerCondition!,
				consequent: { block: lower, arguments: [] },
				alternate: { block: rejected, arguments: [] },
			});
			const [upperCondition] = builder.appendInstruction(
				lower,
				"binary",
				[value, sixteen!],
				{
					attributes: { operator: "<" },
					outputRepresentations: ["boolean"],
				},
			);
			builder.setTerminator(lower, {
				kind: "branch",
				condition: upperCondition!,
				consequent: { block: bounded, arguments: [] },
				alternate: { block: rejected, arguments: [] },
			});
			const [remainder] = builder.appendInstruction(
				bounded,
				"binary",
				[value, sixteen!],
				{
					attributes: { operator: "%" },
					outputRepresentations: [representation],
				},
			);
			builder.setTerminator(bounded, { kind: "return", value: remainder! });
			builder.setTerminator(rejected, { kind: "return", value: zero! });
			const finished = builder.finish(entry);
			const source = { program, function: finished.function, value, bounded };
			expect(pathRanges(source).range(value, bounded)).toBeUndefined();
			const optimized = optimizeCore(
				{ program, context: programAnalysisContext() },
				{ verification: "per-pass" },
			).compilation.program.function(finished.function);
			expect(binaryOperators(optimized)).toContain("%");
		},
	);

	it("does not carry a successful edge through an exceptional predecessor", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const compare = builder.createBlock([{ representation: "i32" }]);
		const handler = builder.createBlock([{ role: "exception" }]);
		const bounded = builder.createBlock();
		const rejected = builder.createBlock();
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [converted] = builder.appendInstruction(entry, "unary", [parameter], {
			attributes: { operator: "~" },
			outputRepresentations: ["i32"],
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: compare, arguments: [converted!] },
		});
		const value = inspectCoreBlockParameters(builder, compare)[0]!.value;
		const [zero] = builder.appendInstruction(compare, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["i32"],
		});
		const [condition] = builder.appendInstruction(compare, "binary", [value, zero!], {
			attributes: { operator: ">=" },
			outputRepresentations: ["boolean"],
		});
		builder.setHandler(compare, handler);
		builder.setTerminator(compare, {
			kind: "branch",
			condition: condition!,
			consequent: { block: bounded, arguments: [] },
			alternate: { block: rejected, arguments: [] },
		});
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: bounded, arguments: [] },
		});
		builder.setTerminator(bounded, { kind: "return", value });
		builder.setTerminator(rejected, { kind: "return", value: zero! });
		const finished = builder.finish(entry);
		const source = { program, function: finished.function, value, bounded };
		expect(pathRanges(source).range(value, bounded)).toMatchObject({
			minimum: -0x8000_0000,
			maximum: 0x7fff_ffff,
		});
	});
});
