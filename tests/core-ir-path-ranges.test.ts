import { describe, expect, it } from "vitest";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CoreAnalysisManager,
	executeCoreOptimizations,
} from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";

function coreProgram(functions: ReadonlyArray<CoreFunction>): CoreProgram {
	return {
		functions,
		stringConstants: [[]],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 0,
	};
}

interface BoundedFunction {
	readonly fn: CoreFunction;
	readonly value: CoreValueId;
	readonly bounded: CoreBlockId;
}

function boundedInt32(polarity: "consequent" | "alternate"): BoundedFunction {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
	const entry = builder.createBlock([{}]);
	const lower = builder.createBlock();
	const bounded = builder.createBlock();
	const rejected = builder.createBlock();
	const parameter = builder.block(entry).parameters[0]!.value;
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
	return { fn: builder.finish(entry), value: value!, bounded };
}

function binaryOperators(fn: CoreFunction): ReadonlyArray<unknown> {
	return fn.blocks.flatMap(({ instructions }) =>
		instructions
			.filter(({ opcode }) => opcode === "binary")
			.map(({ attributes }) => attributes.operator),
	);
}

describe("Core path-sensitive numeric ranges", () => {
	it.each(["consequent", "alternate"] as const)(
		"intersects %s-edge int32 bounds and removes a dominated remainder",
		(polarity) => {
			const source = boundedInt32(polarity);
			const range = new CoreAnalysisManager()
				.loopInductions(source.fn)
				.range(source.value, source.bounded);
			expect(range).toEqual({
				minimum: 0,
				maximum: 15,
				exactSafeIntegers: true,
				excludesNegativeZero: true,
			});

			const program = coreProgram([source.fn]);
			const baseline = executeCoreOptimizations(program, {
				ablations: new Set(["fact-driven"]),
				verification: "per-pass",
			}).program.functions[0]!;
			const optimized = executeCoreOptimizations(program, {
				verification: "per-pass",
			}).program.functions[0]!;
			expect(binaryOperators(baseline)).toContain("%");
			expect(binaryOperators(optimized)).not.toContain("%");
			expect(() =>
				verifyCoreProgram(coreProgram([optimized]), coreOpcodeRegistry),
			).not.toThrow();
		},
	);

	it("consumes a branch-narrowed induction range in source Core", () => {
		let optimized: CoreProgram | undefined;
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
					optimized = program;
				},
			},
		);
		const selected = optimized!.functions.filter((fn) => {
			const name = String.fromCodePoint(
				...(optimized!.stringConstants[fn.metadata.nameStringIndex] ?? []),
			);
			return name === "consequent" || name === "alternate";
		});
		expect(selected).toHaveLength(2);
		for (const fn of selected) expect(binaryOperators(fn)).not.toContain("%");
	});

	it("drops edge refinements when opposite arms rejoin", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const consequent = builder.createBlock();
		const alternate = builder.createBlock();
		const join = builder.createBlock();
		const parameter = builder.block(entry).parameters[0]!.value;
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
		const fn = builder.finish(entry);
		const analysis = new CoreAnalysisManager().loopInductions(fn);
		expect(analysis.range(value!, consequent)).toMatchObject({ minimum: 0 });
		expect(analysis.range(value!, alternate)).toMatchObject({ maximum: -1 });
		expect(analysis.range(value!, join)).toMatchObject({
			minimum: -0x8000_0000,
			maximum: 0x7fff_ffff,
		});
		expect(
			binaryOperators(
				executeCoreOptimizations(coreProgram([fn]), { verification: "per-pass" }).program
					.functions[0]!,
			),
		).toContain("%");
	});

	it.each(["f64", "boxed"] as const)(
		"does not turn %s comparison bounds into an exact-integer proof",
		(representation) => {
			const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const lower = builder.createBlock();
			const bounded = builder.createBlock();
			const rejected = builder.createBlock();
			const parameter = builder.block(entry).parameters[0]!.value;
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
			const fn = builder.finish(entry);
			expect(
				new CoreAnalysisManager().loopInductions(fn).range(value, bounded),
			).toBeUndefined();
			expect(
				binaryOperators(
					executeCoreOptimizations(coreProgram([fn]), { verification: "per-pass" })
						.program.functions[0]!,
				),
			).toContain("%");
		},
	);

	it("does not carry a successful edge through an exceptional predecessor", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const compare = builder.createBlock([{ representation: "i32" }]);
		const handler = builder.createBlock([{ role: "exception" }]);
		const bounded = builder.createBlock();
		const rejected = builder.createBlock();
		const parameter = builder.block(entry).parameters[0]!.value;
		const [converted] = builder.appendInstruction(entry, "unary", [parameter], {
			attributes: { operator: "~" },
			outputRepresentations: ["i32"],
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: compare, arguments: [converted!] },
		});
		const value = builder.block(compare).parameters[0]!.value;
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
		const range = new CoreAnalysisManager()
			.loopInductions(builder.finish(entry))
			.range(value, bounded);
		expect(range).toMatchObject({
			minimum: -0x8000_0000,
			maximum: 0x7fff_ffff,
		});
	});
});
