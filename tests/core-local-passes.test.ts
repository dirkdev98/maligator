import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	conservativeCompilerProgramFacts,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import { coreFunctionNamed } from "./helpers/core-inspection.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "local-passes.js",
		moduleEvaluationOrder: ["local-passes.js"],
		sourceFiles: [{ path: "local-passes.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

function returnedOperation(fn: CoreFunctionStore) {
	const returnBlock = [...fn.blockIds()].find(
		(block) => fn.terminatorPayload(fn.blockTerminator(block)).kind === "return",
	);
	expect(returnBlock).toBeDefined();
	const terminator = fn.terminatorPayload(fn.blockTerminator(returnBlock!));
	if (terminator.kind !== "return") throw new Error("Expected return terminator");
	const definition = fn.valueDefinition(terminator.value);
	expect(definition.kind).toBe("instruction");
	if (definition.kind !== "instruction") throw new Error("Expected returned operation");
	return definition.instruction;
}

function optimizedClosedModule(source: string, sourcePath: string): CoreProgram {
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, sourcePath, parseModule(source)),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(resolveBuildConfig({ engine: { eval: false } })),
				programClosureCertificate(
					{ kind: "whole-program", entry: sourcePath },
					[{ kind: "entry-module", module: sourcePath }],
					[],
				),
			),
			afterCoreOptimization(program) {
				optimized = program;
			},
		},
	);
	expect(optimized).toBeDefined();
	return optimized!;
}

describe("Core local canonicalization", () => {
	it("keeps positive and negative zero as distinct numbered constants", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [positive] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
		});
		const [negative] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: -0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [positive!], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(entry, "storeGlobal", [negative!], {
			attributes: { index: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: positive! });
		builder.finish(entry);

		const fn = optimizeCore({ program, context }).compilation.program.function(
			0 as never,
		);
		const constants = [...fn.instructionIds()]
			.filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					(fn.instructionOpcodeName(instruction) === "createNumber" ||
						fn.instructionOpcodeName(instruction) === "createF64"),
			)
			.map((instruction) => ({
				opcode: fn.instructionOpcodeName(instruction),
				value: fn.instructionAttributes(instruction).value,
			}));
		expect(constants).toHaveLength(2);
		expect(
			constants.some(
				({ opcode, value }) => opcode === "createF64" && Object.is(value, 0),
			),
		).toBe(true);
		expect(
			constants.some(
				({ opcode, value }) => opcode === "createF64" && Object.is(value, -0),
			),
		).toBe(true);
	});

	it("folds negative zero through the f64 constant opcode", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [zero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [negative] = builder.appendInstruction(entry, "unary", [zero!], {
			attributes: { operator: "-" },
		});
		builder.setTerminator(entry, { kind: "return", value: negative! });
		builder.finish(entry);

		const fn = optimizeCore({ program, context }).compilation.program.function(
			0 as never,
		);
		const folded = [...fn.instructionIds()].find(
			(instruction) =>
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "createF64" &&
				Object.is(fn.instructionAttributes(instruction).value, -0),
		);
		expect(folded).toBeDefined();
	});

	it("folds constants and branches while removing copies, dead code, and stale blocks", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const taken = builder.createBlock();
		const skipped = builder.createBlock();
		const forwarding = builder.createBlock([{ representation: "boxed" }]);
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [sum] = builder.appendInstruction(entry, "binary", [one!, two!], {
			attributes: { operator: "+" },
		});
		const [copy] = builder.appendInstruction(entry, "move", [sum!]);
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 99 },
		});
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: taken, arguments: [] },
			alternate: { block: skipped, arguments: [] },
		});
		builder.setTerminator(taken, {
			kind: "jump",
			edge: { block: forwarding, arguments: [copy!] },
		});
		const [unreachable] = builder.appendInstruction(skipped, "createNumber", [], {
			attributes: { value: -1 },
		});
		builder.setTerminator(skipped, { kind: "return", value: unreachable! });
		builder.setTerminator(forwarding, {
			kind: "jump",
			edge: {
				block: exit,
				arguments: [builder.blockParameters(forwarding)[0]!.value],
			},
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: builder.blockParameters(exit)[0]!.value,
		});
		builder.finish(entry);

		const { compilation, report } = optimizeCore({ program, context });
		const fn = compilation.program.function(0 as never);
		const opcodes = [...fn.blockIds()].flatMap((block) =>
			[...fn.bodyInstructionIds(block)].map((instruction) =>
				fn.instructionOpcodeName(instruction),
			),
		);
		expect(opcodes).not.toContain("binary");
		expect(opcodes).not.toContain("move");
		expect([...fn.blockIds()].length).toBeLessThan(5);
		expect(report.output.instructions).toBeLessThan(report.input.instructions);
		expect(
			report.passes.find(({ pass }) => pass === "local-constant-folding"),
		).toMatchObject({ changedItems: 1 });
		expect(
			report.passes.find(({ pass }) => pass === "unreachable-block-removal"),
		).toMatchObject({ changedItems: 1 });
	});

	it("propagates one constant across joins without conflating differing inputs", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const build = (same: boolean) => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{ representation: "boolean" }]);
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock([{ representation: "boolean" }]);
			const success = builder.createBlock();
			const failure = builder.createBlock();
			const condition = builder.blockParameters(entry)[0]!.value;
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			const [leftValue] = builder.appendInstruction(left, "createBoolean", [], {
				attributes: { value: true },
				outputRepresentations: ["boolean"],
			});
			const [rightValue] = builder.appendInstruction(right, "createBoolean", [], {
				attributes: { value: same },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [leftValue!] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [rightValue!] },
			});
			builder.setTerminator(join, {
				kind: "branch",
				condition: builder.blockParameters(join)[0]!.value,
				consequent: { block: success, arguments: [] },
				alternate: { block: failure, arguments: [] },
			});
			const [one] = builder.appendInstruction(success, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [zero] = builder.appendInstruction(failure, "createNumber", [], {
				attributes: { value: 0 },
			});
			builder.setTerminator(success, { kind: "return", value: one! });
			builder.setTerminator(failure, { kind: "return", value: zero! });
			return builder.finish(entry).function;
		};
		const same = build(true);
		const different = build(false);
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const branchCount = (fn: CoreFunctionStore) =>
			[...fn.blockIds()].filter(
				(block) => fn.terminatorPayload(fn.blockTerminator(block)).kind === "branch",
			).length;
		expect(branchCount(optimized.function(same))).toBe(0);
		expect(
			optimized
				.function(same)
				.instructionAttributes(returnedOperation(optimized.function(same))).value,
		).toBe(1);
		expect(branchCount(optimized.function(different))).toBe(1);
	});

	it("preserves coercion, BigInt mixing, NaN, and signed-zero semantics", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { bigintConstants: [1n] });
		const zeroBuilder = new CoreFunctionBuilder(program);
		const zeroEntry = zeroBuilder.createBlock();
		const [negativeZero] = zeroBuilder.appendInstruction(zeroEntry, "createF64", [], {
			attributes: { value: -0 },
			outputRepresentations: ["f64"],
		});
		const [positiveZero] = zeroBuilder.appendInstruction(zeroEntry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		});
		const [sum] = zeroBuilder.appendInstruction(
			zeroEntry,
			"binary",
			[negativeZero!, positiveZero!],
			{ attributes: { operator: "+" }, outputRepresentations: ["f64"] },
		);
		zeroBuilder.setTerminator(zeroEntry, { kind: "return", value: sum! });
		const zeroFunction = zeroBuilder.finish(zeroEntry).function;

		const nanBuilder = new CoreFunctionBuilder(program);
		const nanEntry = nanBuilder.createBlock();
		const [nan] = nanBuilder.appendInstruction(nanEntry, "createF64", [], {
			attributes: { value: Number.NaN },
			outputRepresentations: ["f64"],
		});
		const [nanEquals] = nanBuilder.appendInstruction(nanEntry, "binary", [nan!, nan!], {
			attributes: { operator: "===" },
			outputRepresentations: ["boolean"],
		});
		nanBuilder.setTerminator(nanEntry, { kind: "return", value: nanEquals! });
		const nanFunction = nanBuilder.finish(nanEntry).function;

		const bigintBuilder = new CoreFunctionBuilder(program);
		const bigintEntry = bigintBuilder.createBlock();
		const [bigint] = bigintBuilder.appendInstruction(bigintEntry, "createBigint", [], {
			attributes: { constantIndex: 0 },
		});
		const [number] = bigintBuilder.appendInstruction(bigintEntry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [mixed] = bigintBuilder.appendInstruction(
			bigintEntry,
			"binary",
			[bigint!, number!],
			{
				attributes: { operator: "+" },
			},
		);
		bigintBuilder.setTerminator(bigintEntry, { kind: "return", value: mixed! });
		const bigintFunction = bigintBuilder.finish(bigintEntry).function;

		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const zeroFn = optimized.function(zeroFunction);
		const zeroInstruction = returnedOperation(zeroFn);
		expect(zeroFn.instructionOpcodeName(zeroInstruction)).toBe("createNumber");
		expect(Object.is(zeroFn.instructionAttributes(zeroInstruction).value, 0)).toBe(true);
		const nanFn = optimized.function(nanFunction);
		const nanInstruction = returnedOperation(nanFn);
		expect(nanFn.instructionOpcodeName(nanInstruction)).toBe("createBoolean");
		expect(nanFn.instructionAttributes(nanInstruction).value).toBe(false);
		const bigintFn = optimized.function(bigintFunction);
		expect(bigintFn.instructionOpcodeName(returnedOperation(bigintFn))).toBe("binary");
	});

	it("folds primitive loose equality with ECMAScript coercion rules", () => {
		const strings = ["", "0", "1"].map((value) =>
			[...value].map((unit) => unit.codePointAt(0)!),
		);
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: strings });
		const cases = [
			["null-number", false],
			["null-boolean", true],
			["zero-string", true],
			["empty-false", true],
			["one-true", true],
		] as const;
		const functions = cases.map(([name]) => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const createNumber = (value: number) =>
				builder.appendInstruction(entry, "createNumber", [], {
					attributes: { value },
				})[0]!;
			const createBoolean = (value: boolean) =>
				builder.appendInstruction(entry, "createBoolean", [], {
					attributes: { value },
					outputRepresentations: ["boolean"],
				})[0]!;
			const createString = (index: number) =>
				builder.appendInstruction(entry, "createString", [], {
					attributes: { stringIndex: index },
				})[0]!;
			const nullValue = () => builder.appendInstruction(entry, "createNull", [])[0]!;
			let left: CoreValueId;
			let right: CoreValueId;
			let operator: "==" | "!=" = "==";
			switch (name) {
				case "null-number":
					left = nullValue();
					right = createNumber(0);
					break;
				case "null-boolean":
					left = nullValue();
					right = createBoolean(false);
					operator = "!=";
					break;
				case "zero-string":
					left = createString(1);
					right = createNumber(0);
					break;
				case "empty-false":
					left = createString(0);
					right = createBoolean(false);
					break;
				case "one-true":
					left = createString(2);
					right = createBoolean(true);
					break;
			}
			const [result] = builder.appendInstruction(entry, "binary", [left, right], {
				attributes: { operator },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(entry, { kind: "return", value: result! });
			return builder.finish(entry).function;
		});
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		for (const [index, [, expected]] of cases.entries()) {
			const fn = optimized.function(functions[index]!);
			const instruction = returnedOperation(fn);
			expect(fn.instructionOpcodeName(instruction)).toBe("createBoolean");
			expect(fn.instructionAttributes(instruction).value).toBe(expected);
		}
	});

	it("folds primitive branches and switches with strict case equality", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const branchBuilder = new CoreFunctionBuilder(program);
		const branchEntry = branchBuilder.createBlock();
		const branchTaken = branchBuilder.createBlock();
		const branchSkipped = branchBuilder.createBlock();
		const [truthy] = branchBuilder.appendInstruction(branchEntry, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		const [one] = branchBuilder.appendInstruction(branchEntry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [zero] = branchBuilder.appendInstruction(branchEntry, "createNumber", [], {
			attributes: { value: 0 },
		});
		branchBuilder.setTerminator(branchEntry, {
			kind: "branch",
			condition: truthy!,
			consequent: { block: branchTaken, arguments: [] },
			alternate: { block: branchSkipped, arguments: [] },
		});
		branchBuilder.setTerminator(branchTaken, { kind: "return", value: one! });
		branchBuilder.setTerminator(branchSkipped, { kind: "return", value: zero! });
		const branchFunction = branchBuilder.finish(branchEntry).function;

		const switchBuilder = new CoreFunctionBuilder(program);
		const switchEntry = switchBuilder.createBlock();
		const matched = switchBuilder.createBlock();
		const fallback = switchBuilder.createBlock();
		const [discriminant] = switchBuilder.appendInstruction(
			switchEntry,
			"createNumber",
			[],
			{
				attributes: { value: 1 },
			},
		);
		const [matchedValue] = switchBuilder.appendInstruction(
			switchEntry,
			"createNumber",
			[],
			{
				attributes: { value: 7 },
			},
		);
		const [fallbackValue] = switchBuilder.appendInstruction(
			switchEntry,
			"createNumber",
			[],
			{
				attributes: { value: 9 },
			},
		);
		switchBuilder.setTerminator(switchEntry, {
			kind: "switch",
			discriminant: discriminant!,
			cases: [
				{ value: { kind: "string", index: 0 }, edge: { block: matched, arguments: [] } },
			],
			default: { block: fallback, arguments: [] },
		});
		switchBuilder.setTerminator(matched, { kind: "return", value: matchedValue! });
		switchBuilder.setTerminator(fallback, { kind: "return", value: fallbackValue! });
		const switchFunction = switchBuilder.finish(switchEntry).function;

		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const branchFn = optimized.function(branchFunction);
		expect(branchFn.instructionAttributes(returnedOperation(branchFn)).value).toBe(1);
		const switchFn = optimized.function(switchFunction);
		expect(switchFn.instructionAttributes(returnedOperation(switchFn)).value).toBe(9);
	});

	it("folds arithmetic with exact f64 edge semantics", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [zero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		});
		const [one] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const [nan] = builder.appendInstruction(entry, "binary", [zero!, zero!], {
			attributes: { operator: "/" },
			outputRepresentations: ["f64"],
		});
		const [infinity] = builder.appendInstruction(entry, "binary", [one!, zero!], {
			attributes: { operator: "/" },
			outputRepresentations: ["f64"],
		});
		const [equal] = builder.appendInstruction(entry, "binary", [nan!, infinity!], {
			attributes: { operator: "===" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, { kind: "return", value: equal! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		const returned = returnedOperation(fn);
		expect(fn.instructionOpcodeName(returned)).toBe("createBoolean");
		expect(fn.instructionAttributes(returned).value).toBe(false);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "binary",
			),
		).toEqual([]);
	});

	it("removes TDZ checks only for values proven non-empty", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
		const safeBuilder = new CoreFunctionBuilder(program);
		const safeEntry = safeBuilder.createBlock();
		const [safeValue] = safeBuilder.appendInstruction(safeEntry, "createString", [], {
			attributes: { stringIndex: 0 },
		});
		safeBuilder.appendInstruction(safeEntry, "throwIfTdz", [safeValue!]);
		safeBuilder.setTerminator(safeEntry, { kind: "return", value: safeValue! });
		const safeFunction = safeBuilder.finish(safeEntry).function;

		const unsafeBuilder = new CoreFunctionBuilder(program);
		const unsafeEntry = unsafeBuilder.createBlock([{ representation: "boxed" }]);
		const unsafeValue = unsafeBuilder.blockParameters(unsafeEntry)[0]!.value;
		unsafeBuilder.appendInstruction(unsafeEntry, "throwIfTdz", [unsafeValue]);
		unsafeBuilder.setTerminator(unsafeEntry, { kind: "return", value: unsafeValue });
		const unsafeFunction = unsafeBuilder.finish(unsafeEntry).function;

		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const opcodes = (fn: CoreFunctionStore) =>
			[...fn.instructionIds()]
				.filter((instruction) => fn.instructionKind(instruction) === "operation")
				.map((instruction) => fn.instructionOpcodeName(instruction));
		expect(opcodes(optimized.function(safeFunction))).not.toContain("throwIfTdz");
		expect(opcodes(optimized.function(unsafeFunction))).toContain("throwIfTdz");
	});

	it("revisits TDZ checks after memory forwarding", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			globalCount: 1,
			stringConstants: [[]],
		});
		const build = (initialized: boolean) => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const parameter = builder.blockParameters(entry)[0]!.value;
			const [source] = initialized
				? builder.appendInstruction(entry, "move", [parameter])
				: builder.appendInstruction(entry, "createEmpty", []);
			builder.appendInstruction(entry, "storeGlobal", [source!], {
				attributes: { index: 0 },
			});
			const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.appendInstruction(entry, "throwIfTdz", [loaded!], {
				attributes: { nameStringIndex: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			return builder.finish(entry).function;
		};
		const safe = build(true);
		const unsafe = build(false);
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const opcodes = (fn: CoreFunctionStore) =>
			[...fn.instructionIds()]
				.filter((instruction) => fn.instructionKind(instruction) === "operation")
				.map((instruction) => fn.instructionOpcodeName(instruction));
		expect(opcodes(optimized.function(safe))).not.toContain("throwIfTdz");
		expect(opcodes(optimized.function(unsafe))).toContain("throwIfTdz");
	});

	it("keeps source-closed binding cells initialized across clobbering effects", () => {
		const optimized = optimizedClosedModule(
			`const integer = 42;
			const floating = 3.5;
			const text = "café 🐊";
			const huge = 0x123456789abcdef0123456789n;
			globalThis.constants = [integer, floating, text, huge, true, null, undefined];`,
			"core-closed-tdz-constants.mjs",
		);
		const strings = optimized.stringConstants.map((units) =>
			String.fromCharCode(...units),
		);
		const opcodes = [...optimized.functionIds()].flatMap((functionId) => {
			const fn = optimized.function(functionId);
			return [...fn.instructionIds()]
				.filter((instruction) => fn.instructionKind(instruction) === "operation")
				.map((instruction) => fn.instructionOpcodeName(instruction));
		});
		expect(strings).toEqual(expect.arrayContaining(["", "café 🐊", "constants"]));
		expect(opcodes).not.toContain("throwIfTdz");
	});

	it("keeps a source-closed TDZ check when initialization does not dominate the read", () => {
		const optimized = optimizedClosedModule(
			`if (globalThis.condition) globalThis.answer = value;
			let value = 1;`,
			"core-closed-tdz-before-init.mjs",
		);
		const strings = optimized.stringConstants.map((units) =>
			String.fromCharCode(...units),
		);
		const opcodes = [...optimized.functionIds()].flatMap((functionId) => {
			const fn = optimized.function(functionId);
			return [...fn.instructionIds()]
				.filter((instruction) => fn.instructionKind(instruction) === "operation")
				.map((instruction) => fn.instructionOpcodeName(instruction));
		});
		expect(strings).toContain("value");
		expect(opcodes).toContain("throwIfTdz");
	});

	it("removes coercion work already decided by primitive kinds", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[], []] });
		const build = (coercible: boolean) => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{ representation: "boolean" }]);
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock();
			const condition = builder.blockParameters(entry)[0]!.value;
			const [base] = coercible
				? builder.appendInstruction(entry, "createBoolean", [], {
						attributes: { value: true },
					})
				: builder.appendInstruction(entry, "createNull", []);
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			const [first] = builder.appendInstruction(left, "createString", [], {
				attributes: { stringIndex: 0 },
			});
			const [second] = builder.appendInstruction(right, "createString", [], {
				attributes: { stringIndex: 1 },
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [first!] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [second!] },
			});
			const key = builder.appendBlockParameter(join);
			builder.appendInstruction(join, "requireCoercible", [base!]);
			const [propertyKey] = builder.appendInstruction(join, "toPropertyKey", [
				base!,
				key,
			]);
			builder.setTerminator(join, { kind: "return", value: propertyKey! });
			return builder.finish(entry).function;
		};
		const safe = build(true);
		const unsafe = build(false);
		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const coercions = (fn: CoreFunctionStore) =>
			[...fn.instructionIds()]
				.filter((instruction) => fn.instructionKind(instruction) === "operation")
				.map((instruction) => fn.instructionOpcodeName(instruction))
				.filter((opcode) => opcode === "requireCoercible" || opcode === "toPropertyKey");
		expect(coercions(optimized.function(safe))).toEqual([]);
		expect(coercions(optimized.function(unsafe))).toEqual([
			"requireCoercible",
			"requireCoercible",
		]);
	});

	it("invalidates local value numbering across environment and derived-this rebinding", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const captured = new CoreFunctionBuilder(program);
		const capturedEntry = captured.createBlock();
		const [beforeCaptured] = captured.appendInstruction(
			capturedEntry,
			"loadCaptured",
			[],
			{
				attributes: { level: -1, index: 0 },
			},
		);
		captured.appendInstruction(capturedEntry, "envCopy", []);
		const [afterCaptured] = captured.appendInstruction(
			capturedEntry,
			"loadCaptured",
			[],
			{
				attributes: { level: -1, index: 0 },
			},
		);
		const [capturedSame] = captured.appendInstruction(
			capturedEntry,
			"binary",
			[beforeCaptured!, afterCaptured!],
			{ attributes: { operator: "===" }, outputRepresentations: ["boolean"] },
		);
		captured.setTerminator(capturedEntry, { kind: "return", value: capturedSame! });
		const capturedFunction = captured.finish(capturedEntry).function;

		const derived = new CoreFunctionBuilder(program);
		const derivedEntry = derived.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [parent, argumentsArray] = derived
			.blockParameters(derivedEntry)
			.map(({ value }) => value);
		const [beforeThis] = derived.appendInstruction(derivedEntry, "loadThis", []);
		derived.appendInstruction(derivedEntry, "constructSuper", [parent!, argumentsArray!]);
		const [afterThis] = derived.appendInstruction(derivedEntry, "loadThis", []);
		const [thisSame] = derived.appendInstruction(
			derivedEntry,
			"binary",
			[beforeThis!, afterThis!],
			{ attributes: { operator: "===" }, outputRepresentations: ["boolean"] },
		);
		derived.setTerminator(derivedEntry, { kind: "return", value: thisSame! });
		const derivedFunction = derived.finish(derivedEntry).function;

		const optimized = optimizeCore({ program, context }, { verification: "per-pass" })
			.compilation.program;
		const count = (fn: CoreFunctionStore, opcode: string) =>
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === opcode,
			).length;
		expect(count(optimized.function(capturedFunction), "loadCaptured")).toBe(2);
		expect(count(optimized.function(derivedFunction), "loadThis")).toBe(2);
	});

	it("folds closed primitive observations before target lowering", () => {
		let observations: ReadonlyArray<{
			readonly opcode: string;
			readonly operator: unknown;
		}> = [];
		let booleans: ReadonlyArray<unknown> = [];
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function observe(condition) {
					const text = condition ? "value" : "other";
					const absent = condition ? null : undefined;
					return typeof text === "string" && text !== 1 && !absent;
				}
				globalThis.result = observe(globalThis.condition);`,
				"core-primitive-observations.js",
			),
			{
				afterCoreOptimization(program) {
					const fn = coreFunctionNamed(program, "observe");
					if (fn === undefined) throw new Error("Expected observe function");
					const operations = [...fn.instructionIds()].filter(
						(instruction) => fn.instructionKind(instruction) === "operation",
					);
					observations = operations
						.map((instruction) => ({
							opcode: fn.instructionOpcodeName(instruction),
							operator: fn.instructionAttributes(instruction).operator,
						}))
						.filter(
							({ opcode, operator }) =>
								opcode === "typeofCompare" ||
								(opcode === "unary" && (operator === "typeof" || operator === "!")) ||
								(opcode === "binary" && (operator === "===" || operator === "!==")),
						);
					booleans = operations.flatMap((instruction) =>
						fn.instructionOpcodeName(instruction) === "createBoolean"
							? [fn.instructionAttributes(instruction).value]
							: [],
					);
				},
			},
		);
		expect(observations).toEqual([]);
		expect(booleans).toContain(true);
	});

	it("eliminates a deep pure graph while retaining unused observable effects", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [returned] = builder.appendInstruction(entry, "createUndefined", []);
		let dead = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		})[0]!;
		for (let index = 0; index < 32; index++) {
			dead = builder.appendInstruction(entry, "mathUnaryNumber", [dead], {
				attributes: { operation: index % 2 === 0 ? "Math.sin" : "Math.cos" },
				outputRepresentations: ["f64"],
			})[0]!;
		}
		builder.appendInstruction(entry, "createObject", []);
		builder.appendInstruction(entry, "call", [returned!, returned!]);
		builder.setTerminator(entry, { kind: "return", value: returned! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		const opcodes = [...fn.bodyInstructionIds(fn.entry)].map((instruction) =>
			fn.instructionOpcodeName(instruction),
		);
		expect(opcodes).toEqual(["createUndefined", "createObject", "call"]);
		expect(fn.isValueLive(dead)).toBe(false);
	});

	it("removes reconverged guards and empty orphan facts", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const exit = builder.createBlock();
		const condition = builder.blockParameters(entry)[0]!.value;
		builder.setGuardTerminator(entry, {
			condition,
			success: { block: exit, arguments: [] },
			fallback: { block: exit, arguments: [] },
			fact: { kind: "unused-proof", value: true, claims: [], origin: "test" },
		});
		builder.addFact({
			kind: "unused-summary",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "unused" },
			obligations: [],
			origin: "test",
		});
		builder.setTerminator(exit, { kind: "return", value: condition });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(
			[...fn.blockIds()].map(
				(block) => fn.terminatorPayload(fn.blockTerminator(block)).kind,
			),
		).not.toContain("guard");
		expect([...fn.factIds()]).toEqual([]);
	});
});
