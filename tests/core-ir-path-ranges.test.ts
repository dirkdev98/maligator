import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import type { CoreLoopComparison } from "../src/compiler/core/core-ir-loops.ts";
import { analyzeCoreLoopInductions } from "../src/compiler/core/core-ir-loops.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { CORE_NO_EFFECTS } from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreValueId,
	CoreRepresentation,
} from "../src/compiler/core/core-ir.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { COMPILER_VALUE_KIND_NUMBER } from "../src/compiler/shared/compiler-value-kinds.ts";
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

function primitiveNumberProof(builder: CoreFunctionBuilder) {
	return builder.addFact({
		kind: "primitive-effects",
		value: [COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_NUMBER],
		claims: [],
		validity: {
			kind: "summary",
			digest: `primitive:binary:${COMPILER_VALUE_KIND_NUMBER},${COMPILER_VALUE_KIND_NUMBER}`,
		},
		obligations: [],
		origin: "bounded-numeric-inputs",
	});
}

function boundedInt32(
	polarity: "consequent" | "alternate",
	resultRepresentation: CoreRepresentation = "i32",
	divisor = 16,
	dividendRepresentation: CoreRepresentation = "i32",
): BoundedFunction {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{}]);
	const lower = builder.createBlock();
	const bounded = builder.createBlock();
	const rejected = builder.createBlock();
	const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
	const [zero] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 0 },
		outputRepresentations: ["i32"],
	});
	const [value] = builder.appendInstruction(entry, "binary", [parameter, zero!], {
		attributes: { operator: "|" },
		outputRepresentations: [dividendRepresentation],
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
	const proof = primitiveNumberProof(builder);
	const modulus =
		divisor === 16
			? sixteen!
			: builder.appendInstruction(bounded, "createF64", [], {
					attributes: { value: divisor },
					outputRepresentations: ["f64"],
				})[0]!;
	const [remainder] = builder.appendInstruction(bounded, "binary", [value!, modulus], {
		effectRefinement: { effects: CORE_NO_EFFECTS, proof },
		attributes: { operator: "%" },
		outputRepresentations: [resultRepresentation],
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
	return analyzeCoreLoopInductions(
		source.program,
		fn,
		cfg,
		coreCanonicalValueRoots(fn, cfg),
	);
}

function relationalInt32(
	operator: CoreLoopComparison,
	options: {
		swapped?: boolean;
		guard?: boolean;
		boundRepresentation?: "f64" | "boxed";
		lateLimit?: number;
	} = {},
) {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
	const entry = builder.createBlock([{}, {}]);
	const bounded = builder.createBlock();
	const alternate = builder.createBlock();
	const join = builder.createBlock();
	const compared = options.lateLimit === undefined ? bounded : builder.createBlock();
	const [input, limit] = inspectCoreBlockParameters(builder, entry);
	const [value] = builder.appendInstruction(entry, "unary", [input!.value], {
		attributes: { operator: "~" },
		outputRepresentations: ["i32"],
	});
	let bound = limit!.value;
	if (options.boundRepresentation === "f64")
		bound = builder.appendInstruction(entry, "unary", [bound], {
			attributes: { operator: "+" },
			outputRepresentations: ["f64"],
		})[0]!;
	else if (options.boundRepresentation === undefined) {
		const [mask] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 15 },
			outputRepresentations: ["i32"],
		});
		bound = builder.appendInstruction(entry, "binary", [bound, mask!], {
			attributes: { operator: "&" },
			outputRepresentations: ["i32"],
		})[0]!;
	}
	const [condition] = builder.appendInstruction(
		entry,
		"binary",
		options.swapped ? [bound, value!] : [value!, bound],
		{ attributes: { operator }, outputRepresentations: ["boolean"] },
	);
	const yes = { block: compared, arguments: [] };
	const no = { block: alternate, arguments: [] };
	builder.setTerminator(
		entry,
		options.guard
			? {
					kind: "guard",
					condition: condition!,
					fact: primitiveNumberProof(builder),
					success: yes,
					fallback: no,
				}
			: { kind: "branch", condition: condition!, consequent: yes, alternate: no },
	);
	if (options.lateLimit !== undefined) {
		const [limit] = builder.appendInstruction(compared, "createF64", [], {
			attributes: { value: options.lateLimit },
			outputRepresentations: ["i32"],
		});
		const [condition] = builder.appendInstruction(compared, "binary", [bound, limit!], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(
			compared,
			options.guard
				? {
						kind: "guard",
						condition: condition!,
						fact: primitiveNumberProof(builder),
						success: { block: bounded, arguments: [] },
						fallback: no,
					}
				: {
						kind: "branch",
						condition: condition!,
						consequent: { block: bounded, arguments: [] },
						alternate: no,
					},
		);
	}
	for (const block of [bounded, alternate])
		builder.setTerminator(block, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
	builder.setTerminator(join, { kind: "return", value: value! });
	return {
		program,
		function: builder.finish(entry).function,
		value: value!,
		bounded,
		alternate,
		join,
		entry,
		bound,
		compared,
	};
}

describe("Core path-sensitive numeric ranges", () => {
	it.each([
		[-16, true],
		[15.5, true],
		[-15.5, true],
		[Infinity, true],
		[-Infinity, true],
		[15, false],
		[0, false],
		[-0, false],
		[NaN, false],
	] as const)(
		"uses the magnitude of constant divisor %s for identity=%s",
		(divisor, identity) => {
			const source = boundedInt32("consequent", "f64", divisor);
			const outcome = optimizeCore(
				{ program: source.program, context: programAnalysisContext() },
				{ verification: "per-pass" },
			);
			expect(
				binaryOperators(outcome.compilation.program.function(source.function)).includes(
					"%",
				),
			).toBe(!identity);
		},
	);
	it.each([false, true])(
		"does not use an entry backedge to prove its own comparison with variable=%s",
		(variable) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
			const entry = builder.createBlock([{}, {}]);
			const exit = builder.createBlock();
			const inputs = inspectCoreBlockParameters(builder, entry).map(({ value }) => value);
			const [value] = builder.appendInstruction(entry, "unary", [inputs[0]!], {
				attributes: { operator: "~" },
				outputRepresentations: ["i32"],
			});
			const [constant] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: 15 },
				outputRepresentations: ["i32"],
			});
			const bound = variable
				? builder.appendInstruction(entry, "binary", [inputs[1]!, constant!], {
						attributes: { operator: "&" },
						outputRepresentations: ["i32"],
					})[0]!
				: constant!;
			const [condition] = builder.appendInstruction(entry, "binary", [value!, bound], {
				attributes: { operator: "<" },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(entry, {
				kind: "branch",
				condition: condition!,
				consequent: { block: entry, arguments: inputs },
				alternate: { block: exit, arguments: [] },
			});
			builder.setTerminator(exit, { kind: "return", value: value! });
			const functionId = builder.finish(entry).function;
			const cfg = buildCoreControlFlow(program, functionId);
			expect(cfg.dominatesEdge(entry, entry, entry)).toBe(false);
			expect(
				pathRanges({
					program,
					function: functionId,
					value: value!,
					bounded: entry,
				}).range(value!, entry),
			).toMatchObject({
				minimum: -0x8000_0000,
				maximum: 0x7fff_ffff,
			});
		},
	);
	it.each([false, true])(
		"keeps earlier observations separate from later guard bounds with guard=%s",
		(guard) => {
			const source = relationalInt32("<", { guard, lateLimit: 8 });
			const analysis = pathRanges(source);
			expect(analysis.range(source.value, source.bounded)).toMatchObject({ maximum: 6 });
			expect(analysis.range(source.value, source.compared)).toMatchObject({
				maximum: 14,
			});
			expect(analysis.range(source.value, source.join)).toMatchObject({
				minimum: -0x8000_0000,
				maximum: 0x7fff_ffff,
			});
		},
	);
	it.each([
		["n<bound&&bound<16", "n", 0, 14],
		["n<middle&&middle<bound&&bound<16", "n", 0, 13],
		["n>middle&&middle>bound&&bound>16", "n", 19, 0xffff_ffff],
		["n<=bound&&bound<=n&&bound<16", "n", 0, 15],
		["n<=middle&&middle<=bound&&bound<=n&&bound<16", "n", 0, 15],
		["n<=middle&&middle<=bound&&bound<=n&&bound<16", "n+1", 1, 16],
		["n<bound&&bound<16", "n+1", 1, 15],
	] as const)(
		"propagates %s through %s independently of query order",
		(condition, result, minimum, maximum) => {
			const { program } = lowerSemanticProgramToCore(
				analyzeSourceAndRunSemanticAnalysis(
					`function probe(value,limit,other){const n=value>>>0;const middle=limit>>>0;const bound=other&255;if(${condition})return ${result};throw 0;}globalThis.probe=probe;`,
					"/transitive-bounds.mjs",
				),
				{ facts: programAnalysisContext().facts },
			);
			const fn = coreFunctionNamed(program, "probe")!;
			const block = [...fn.blockIds()].find(
				(block) => fn.instructionKind(fn.blockTerminator(block)) === "return",
			)!;
			const returned = inspectCoreTerminatorPayload(fn, fn.blockTerminator(block));
			if (returned.kind !== "return") throw new Error("Missing probe return");
			for (const reverse of [false, true]) {
				const analysis = pathRanges({
					program,
					function: fn.id,
					value: returned.value,
					bounded: block,
				});
				const values = [...fn.valueIds()];
				if (reverse) values.reverse();
				for (const value of values) analysis.range(value, block);
				expect(analysis.range(returned.value, block)).toEqual({
					minimum,
					maximum,
					exactSafeIntegers: true,
					excludesNegativeZero: true,
				});
			}
		},
	);
	it("bounds analysis work for a long relational chain without excluding valid values", () => {
		const count = 96;
		const declarations = Array.from(
			{ length: count },
			(_, index) => `const v${index}=input[${index}]>>>0;`,
		).join("");
		const comparisons = Array.from(
			{ length: count - 1 },
			(_, index) => `v${index}<v${index + 1}`,
		);
		comparisons.push(`v${count - 1}<256`);
		const { program } = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function probe(input){${declarations}if(${comparisons.join("&&")})return v0;throw 0;}globalThis.probe=probe;`,
				"/bounded-relational-work.mjs",
			),
			{ facts: programAnalysisContext().facts },
		);
		const fn = coreFunctionNamed(program, "probe")!;
		const cfg = buildCoreControlFlow(program, fn.id);
		const analysis = analyzeCoreLoopInductions(
			program,
			fn,
			cfg,
			coreCanonicalValueRoots(fn, cfg),
		);
		const block = [...fn.blockIds()].find(
			(block) => fn.instructionKind(fn.blockTerminator(block)) === "return",
		)!;
		const returned = inspectCoreTerminatorPayload(fn, fn.blockTerminator(block));
		if (returned.kind !== "return") throw new Error("Missing probe return");
		let producerQueries = 0;
		const query = analysis.rangeQuery(() => {
			producerQueries++;
			return undefined;
		});
		const range = query(returned.value, block);
		expect(producerQueries).toBeLessThanOrEqual(32);
		expect(range).toBeDefined();
		if (range === undefined || range === null) throw new Error("Missing integer basis");
		expect(range.minimum).toBeLessThanOrEqual(0);
		expect(range.maximum).toBeGreaterThanOrEqual(160);
	});
	it.each([
		["i32", "f64"],
		["i32", "boxed"],
		["boxed", "f64"],
		["f64", "i32"],
	] as const)(
		"eliminates an identity remainder while preserving %s to %s transport",
		(from, to) => {
			const source = boundedInt32("consequent", to, 16, from);
			const outcome = optimizeCore(
				{ program: source.program, context: programAnalysisContext() },
				{ verification: "per-pass", instrumentation: "full" },
			);
			expect(
				binaryOperators(outcome.compilation.program.function(source.function)),
			).not.toContain("%");
			expect(
				outcome.report.passes.find(
					({ pass }) => pass === "path-range-strength-reduction",
				),
			).toMatchObject({ changedItems: 1 });
		},
	);
	describe.each([false, true])("bounded variable comparisons with guard=%s", (guard) => {
		it.each([
			["<", false, -0x8000_0000, 14, 0, 0x7fff_ffff],
			["<=", false, -0x8000_0000, 15, 1, 0x7fff_ffff],
			[">", false, 1, 0x7fff_ffff, -0x8000_0000, 15],
			[">=", false, 0, 0x7fff_ffff, -0x8000_0000, 14],
			[">", true, -0x8000_0000, 14, 0, 0x7fff_ffff],
			[">=", true, -0x8000_0000, 15, 1, 0x7fff_ffff],
			["<", true, 1, 0x7fff_ffff, -0x8000_0000, 15],
			["<=", true, 0, 0x7fff_ffff, -0x8000_0000, 14],
		] as const)(
			"narrows %s on both edges with swapped operands=%s",
			(operator, swapped, yesMin, yesMax, noMin, noMax) => {
				const source = relationalInt32(operator, { swapped, guard });
				const analysis = pathRanges(source);
				expect(analysis.range(source.value, source.bounded)).toMatchObject({
					minimum: yesMin,
					maximum: yesMax,
				});
				expect(analysis.range(source.value, source.alternate)).toMatchObject({
					minimum: noMin,
					maximum: noMax,
				});
				for (const block of [source.entry, source.join])
					expect(analysis.range(source.value, block)).toMatchObject({
						minimum: -0x8000_0000,
						maximum: 0x7fff_ffff,
					});
			},
		);
	});
	it("waits for the comparison operand's normal result before seeding either edge", () => {
		const source = relationalInt32("<");
		const fn = source.program.function(source.function);
		const bound = fn.kernel.valueDefinitionOwner(source.bound);
		const query = pathRanges(source).rangeQuery((instruction) =>
			instruction === bound ? null : undefined,
		);
		expect(query(source.value, source.bounded)).toBeNull();
		expect(query(source.value, source.alternate)).toBeNull();
		expect(query(source.value, source.entry)).toMatchObject({
			minimum: -0x8000_0000,
			maximum: 0x7fff_ffff,
		});
	});
	it.each(["f64", "boxed"] as const)(
		"does not use an unbounded %s comparison operand as an integer bound",
		(boundRepresentation) => {
			const source = relationalInt32("<", { boundRepresentation });
			const analysis = pathRanges(source);
			for (const block of [source.bounded, source.alternate])
				expect(analysis.range(source.value, block)).toMatchObject({
					minimum: -0x8000_0000,
					maximum: 0x7fff_ffff,
				});
		},
	);
	it("does not admit relational-only floating inputs as integer opportunities", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const bounded = builder.createBlock();
		const alternate = builder.createBlock();
		const [left, right] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) =>
				builder.appendInstruction(entry, "unary", [value], {
					attributes: { operator: "+" },
					outputRepresentations: ["f64"],
				})[0]!,
		);
		const [condition] = builder.appendInstruction(entry, "binary", [left!, right!], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: bounded, arguments: [] },
			alternate: { block: alternate, arguments: [] },
		});
		for (const block of [bounded, alternate])
			builder.setTerminator(block, { kind: "return", value: left! });
		const analysis = pathRanges({
			program,
			function: builder.finish(entry).function,
			value: left!,
			bounded,
		});
		expect(analysis.hasNumericRanges).toBe(false);
		expect(analysis.range(left!, bounded)).toBeUndefined();
	});
	it("retires primitive effect proofs when module constants eliminate a bounded remainder", () => {
		const config = resolveBuildConfig({});
		let reduced = 0;
		compileEntrypoint(
			new URL("./local/static-binding-constants.mjs", import.meta.url).pathname,
			{
				buildConfig: config,
				stripTypes: stripCompactTypes,
				coreVerification: "per-pass",
				coreInstrumentation: "full",
				afterCoreOptimization(_program, _context, report) {
					reduced =
						report.passes.find(({ pass }) => pass === "path-range-strength-reduction")
							?.changedItems ?? 0;
				},
			},
		);
		expect(reduced).toBeGreaterThan(0);
	});

	it.each([false, true])(
		"folds comparisons from int32 joins with constant inputs: %s",
		(constants) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
			const entry = builder.createBlock([{}, {}, {}]);
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock([{ representation: "i32" }]);
			const [condition] = builder.appendInstruction(
				entry,
				"unary",
				[inspectCoreBlockParameters(builder, entry)[0]!.value],
				{
					attributes: { operator: "!" },
					outputRepresentations: ["boolean"],
				},
			);
			const inputLeft = inspectCoreBlockParameters(builder, entry)[1]!.value;
			const inputRight = inspectCoreBlockParameters(builder, entry)[2]!.value;
			builder.setTerminator(entry, {
				kind: "branch",
				condition: condition!,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			const first = constants
				? builder.appendInstruction(left, "createF64", [], {
						attributes: { value: 1 },
						outputRepresentations: ["i32"],
					})[0]!
				: builder.appendInstruction(left, "unary", [inputLeft], {
						attributes: { operator: "~" },
						outputRepresentations: ["i32"],
					})[0]!;
			const second = constants
				? builder.appendInstruction(right, "createF64", [], {
						attributes: { value: 2 },
						outputRepresentations: ["i32"],
					})[0]!
				: builder.appendInstruction(right, "unary", [inputRight], {
						attributes: { operator: "~" },
						outputRepresentations: ["i32"],
					})[0]!;
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [first] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [second] },
			});
			const value = inspectCoreBlockParameters(builder, join)[0]!.value;
			const [limit] = builder.appendInstruction(join, "createF64", [], {
				attributes: { value: 0x8000_0000 },
				outputRepresentations: ["f64"],
			});
			const proof = primitiveNumberProof(builder);
			const [comparison] = builder.appendInstruction(join, "binary", [value, limit!], {
				effectRefinement: { effects: CORE_NO_EFFECTS, proof },
				attributes: { operator: "<" },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(join, { kind: "return", value: comparison! });
			const finished = builder.finish(entry);
			const source = { program, function: finished.function, value, bounded: join };
			expect(pathRanges(source).range(value, join)).toEqual({
				minimum: constants ? 1 : -0x8000_0000,
				maximum: constants ? 2 : 0x7fff_ffff,
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
		},
	);

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

	it.each([false, true])(
		"does not carry an edge through an exceptional predecessor with variable bound=%s",
		(variable) => {
			const program = new CoreProgram(coreOpcodeRegistry);
			const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
			const entry = builder.createBlock([{}, {}]);
			const compare = builder.createBlock([{ representation: "i32" }]);
			const handler = builder.createBlock([{ role: "exception" }]);
			const bounded = builder.createBlock();
			const rejected = builder.createBlock();
			const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const [converted] = builder.appendInstruction(entry, "unary", [parameter], {
				attributes: { operator: "~" },
				outputRepresentations: ["i32"],
			});
			const [mask] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: 15 },
				outputRepresentations: ["i32"],
			});
			const [bound] = builder.appendInstruction(
				entry,
				"binary",
				[inspectCoreBlockParameters(builder, entry)[1]!.value, mask!],
				{ attributes: { operator: "&" }, outputRepresentations: ["i32"] },
			);
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: compare, arguments: [converted!] },
			});
			const value = inspectCoreBlockParameters(builder, compare)[0]!.value;
			const [zero] = builder.appendInstruction(compare, "createF64", [], {
				attributes: { value: 0 },
				outputRepresentations: ["i32"],
			});
			const [condition] = builder.appendInstruction(
				compare,
				"binary",
				[value, variable ? bound! : zero!],
				{
					attributes: { operator: variable ? "<" : ">=" },
					outputRepresentations: ["boolean"],
				},
			);
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
		},
	);
});
