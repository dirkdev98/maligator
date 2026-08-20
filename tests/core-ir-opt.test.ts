import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	coreOptimizationMetrics,
	executeCoreOptimizations,
} from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import { CORE_NO_EFFECTS, CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type { CoreFunction, CoreProgram } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { coreRegisterClasses } from "../src/compiler/target/core-target-lowering.ts";
import {
	deserializeVmDefinition,
	serializeVmDefinition,
} from "../src/compiler/target/serialize-vm.ts";

function programWithConstants(): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [first] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [duplicate] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [unused] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 2 },
	});
	const [moved] = builder.appendInstruction(entry, "move", [duplicate!]);
	void first;
	void unused;
	builder.setTerminator(entry, { kind: "return", value: moved! });
	const core = builder.finish(entry);
	return coreProgram([core]);
}

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

describe("Core IR optimizer", () => {
	it("counts refined safepoints, boxed roots, and guard terminators in traces", () => {
		const rooted = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const rootedEntry = rooted.createBlock([{}]);
		const parameter = rooted.block(rootedEntry).parameters[0]!.value;
		rooted.appendInstruction(rootedEntry, "createObject", []);
		rooted.setTerminator(rootedEntry, { kind: "return", value: parameter });

		const refined = new CoreFunctionBuilder(1, coreOpcodeRegistry, { parameterCount: 1 });
		const refinedEntry = refined.createBlock([{}]);
		const refinedParameter = refined.block(refinedEntry).parameters[0]!.value;
		const proof = refined.addFact({
			kind: "no-gc",
			value: true,
			validity: { kind: "summary", digest: "metrics-no-gc" },
			obligations: [],
			origin: "metrics-test",
		});
		refined.appendInstruction(refinedEntry, "createObject", [], {
			effectRefinement: { effects: CORE_NO_EFFECTS, proof },
		});
		refined.setTerminator(refinedEntry, {
			kind: "return",
			value: refinedParameter,
		});

		const guarded = new CoreFunctionBuilder(2, coreOpcodeRegistry, { parameterCount: 1 });
		const guardedEntry = guarded.createBlock([{}]);
		const condition = guarded.block(guardedEntry).parameters[0]!.value;
		const success = guarded.createBlock();
		const fallback = guarded.createBlock();
		guarded.setGuardTerminator(guardedEntry, {
			condition,
			success: { block: success, arguments: [] },
			fallback: { block: fallback, arguments: [] },
			fact: { kind: "metrics-guard", value: true, origin: "metrics-test" },
		});
		guarded.setTerminator(success, { kind: "return", value: condition });
		guarded.setTerminator(fallback, { kind: "return", value: condition });

		const metrics = coreOptimizationMetrics(
			coreProgram([
				rooted.finish(rootedEntry),
				refined.finish(refinedEntry),
				guarded.finish(guardedEntry),
			]),
		);
		expect(metrics.safepoints).toBe(1);
		expect(metrics.rootedValues).toBe(1);
		expect(metrics.worldGuards).toBe(1);
	});

	it("propagates one constant across executable join edges and removes the dead branch", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{ representation: "boolean" }]);
		const success = builder.createBlock();
		const failure = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftTrue] = builder.appendInstruction(left, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		const [rightTrue] = builder.appendInstruction(right, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftTrue!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightTrue!] },
		});
		builder.setTerminator(join, {
			kind: "branch",
			condition: builder.block(join).parameters[0]!.value,
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

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]));
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) =>
					name === "sparse-conditional-constant-propagation" && changed,
			),
		).toBe(true);
		expect(fn.blocks.flatMap(({ terminator }) => terminator.kind)).not.toContain(
			"branch",
		);
		const terminator = fn.blocks[0]!.terminator;
		expect(terminator.kind).toBe("return");
		if (terminator.kind !== "return") throw new Error("expected folded return");
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.find(({ outputs }) => outputs.includes(terminator.value))?.attributes.value,
		).toBe(1);
	});

	it("preserves coercions, BigInt mixing, NaN, and signed-zero behavior", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [negativeZero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: -0 },
			outputRepresentations: ["f64"],
		});
		const [positiveZero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		});
		const [sum] = builder.appendInstruction(
			entry,
			"binary",
			[negativeZero!, positiveZero!],
			{
				attributes: { operator: "+" },
				outputRepresentations: ["f64"],
			},
		);
		const [nan] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: Number.NaN },
			outputRepresentations: ["f64"],
		});
		const [nanEquals] = builder.appendInstruction(entry, "binary", [nan!, nan!], {
			attributes: { operator: "===" },
			outputRepresentations: ["boolean"],
		});
		const [bigint] = builder.appendInstruction(entry, "createBigint", [], {
			attributes: { constantIndex: 0 },
		});
		builder.appendInstruction(entry, "binary", [bigint!, positiveZero!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(entry, { kind: "return", value: sum! });
		const comparisonBuilder = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const comparisonEntry = comparisonBuilder.createBlock();
		const [comparisonNan] = comparisonBuilder.appendInstruction(
			comparisonEntry,
			"createF64",
			[],
			{
				attributes: { value: Number.NaN },
				outputRepresentations: ["f64"],
			},
		);
		const [comparisonResult] = comparisonBuilder.appendInstruction(
			comparisonEntry,
			"binary",
			[comparisonNan!, comparisonNan!],
			{
				attributes: { operator: "===" },
				outputRepresentations: ["boolean"],
			},
		);
		comparisonBuilder.setTerminator(comparisonEntry, {
			kind: "return",
			value: comparisonResult!,
		});

		const outcome = executeCoreOptimizations({
			...coreProgram([builder.finish(entry), comparisonBuilder.finish(comparisonEntry)]),
			bigintConstants: [1n],
		});
		const instructions = outcome.program.functions[0]!.blocks[0]!.instructions;
		const sumTerminator = outcome.program.functions[0]!.blocks[0]!.terminator;
		expect(sumTerminator.kind).toBe("return");
		if (sumTerminator.kind !== "return") throw new Error("expected numeric return");
		const foldedSum = instructions.find(({ outputs }) =>
			outputs.includes(sumTerminator.value),
		);
		expect(foldedSum?.opcode).toBe("createF64");
		expect(Object.is(foldedSum?.attributes.value, 0)).toBe(true);
		expect(
			instructions.find(({ outputs }) => outputs.includes(nanEquals!)),
		).toBeUndefined();
		expect(outcome.program.functions[1]!.blocks[0]!.instructions).toContainEqual(
			expect.objectContaining({
				opcode: "createBoolean",
				attributes: { value: false },
			}),
		);
		const mixedBigint = instructions.find(
			({ opcode, inputs }) => opcode === "binary" && inputs.includes(bigint!),
		);
		expect(mixedBigint?.attributes.operator).toBe("+");
	});

	it("folds primitive loose equality with the exact ECMAScript coercion rules", () => {
		type Literal =
			| { readonly kind: "null" }
			| { readonly kind: "undefined" }
			| { readonly kind: "boolean"; readonly value: boolean }
			| { readonly kind: "number"; readonly value: number }
			| { readonly kind: "string"; readonly index: number };
		const build = (
			functionIndex: number,
			left: Literal,
			operator: "==" | "!=",
			right: Literal,
		): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry);
			const entry = builder.createBlock();
			const append = (literal: Literal) => {
				switch (literal.kind) {
					case "null":
						return builder.appendInstruction(entry, "createNull", [])[0]!;
					case "undefined":
						return builder.appendInstruction(entry, "createUndefined", [])[0]!;
					case "boolean":
						return builder.appendInstruction(entry, "createBoolean", [], {
							attributes: { value: literal.value },
							outputRepresentations: ["boolean"],
						})[0]!;
					case "number":
						return builder.appendInstruction(entry, "createF64", [], {
							attributes: { value: literal.value },
							outputRepresentations: ["f64"],
						})[0]!;
					case "string":
						return builder.appendInstruction(entry, "createString", [], {
							attributes: { stringIndex: literal.index },
						})[0]!;
				}
			};
			const [result] = builder.appendInstruction(
				entry,
				"binary",
				[append(left), append(right)],
				{ attributes: { operator }, outputRepresentations: ["boolean"] },
			);
			builder.setTerminator(entry, { kind: "return", value: result! });
			return builder.finish(entry);
		};
		const cases = [
			[{ kind: "null" }, "==", { kind: "number", value: 0 }, false],
			[{ kind: "null" }, "!=", { kind: "boolean", value: false }, true],
			[{ kind: "string", index: 1 }, "==", { kind: "number", value: 0 }, true],
			[{ kind: "string", index: 0 }, "==", { kind: "boolean", value: false }, true],
			[{ kind: "string", index: 2 }, "==", { kind: "boolean", value: true }, true],
		] as const satisfies ReadonlyArray<readonly [Literal, "==" | "!=", Literal, boolean]>;
		const outcome = executeCoreOptimizations({
			...coreProgram(
				cases.map(([left, operator, right], index) =>
					build(index, left, operator, right),
				),
			),
			stringConstants: [[], [48], [49]],
		});
		for (const [index, equalityCase] of cases.entries()) {
			const expected = equalityCase[3];
			const fn = outcome.program.functions[index]!;
			const terminator = fn.blocks[0]!.terminator;
			expect(terminator.kind).toBe("return");
			if (terminator.kind !== "return") throw new Error("expected equality return");
			expect(
				fn.blocks[0]!.instructions.find(({ outputs }) =>
					outputs.includes(terminator.value),
				),
			).toMatchObject({ opcode: "createBoolean", attributes: { value: expected } });
		}
	});

	it("eliminates copies, locally numbers values, and removes dead producers", () => {
		const result = executeCoreOptimizations(programWithConstants());
		const fn = result.program.functions[0]!;
		expect(result.changed).toBe(true);
		expect(fn.blocks[0]!.instructions).toHaveLength(1);
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "createNumber",
			attributes: { value: 1 },
		});
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: fn.blocks[0]!.instructions[0]!.outputs[0],
		});
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
		expect(result.passes.some(({ changed }) => changed)).toBe(true);
	});

	it("numbers pure values through the dominator tree", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const [dominating] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 42 },
		});
		const left = builder.createBlock();
		const right = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		for (const block of [left, right]) {
			const [duplicate] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 42 },
			});
			builder.setTerminator(block, { kind: "return", value: duplicate! });
		}

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]));
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "copy-and-value-number" && changed,
			),
		).toBe(true);
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(
					({ opcode, attributes }) =>
						opcode === "createNumber" && attributes.value === 42,
				),
		).toHaveLength(1);
		expect(
			fn.blocks
				.filter(({ id }) => id !== fn.entry)
				.every(
					({ terminator }) =>
						terminator.kind === "return" && terminator.value === dominating,
				),
		).toBe(true);
	});

	it("reuses partitioned loads only when every path preserves their effect domain", () => {
		const build = (writeOnLeft: boolean, functionIndex: number): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const condition = builder.block(entry).parameters[0]!.value;
			const [before] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock();
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			if (writeOnLeft) {
				const [replacement] = builder.appendInstruction(left, "createUndefined", []);
				builder.appendInstruction(left, "storeGlobal", [replacement!], {
					attributes: { index: 0 },
				});
			}
			builder.setTerminator(left, { kind: "jump", edge: { block: join, arguments: [] } });
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			const [after] = builder.appendInstruction(join, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			const [same] = builder.appendInstruction(join, "binary", [before!, after!], {
				attributes: { operator: "===" },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(join, { kind: "return", value: same! });
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations({
			...coreProgram([build(false, 0), build(true, 1)]),
			globalCount: 1,
		});
		const loadCount = (fn: CoreFunction) =>
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(({ opcode }) => opcode === "loadGlobal").length;
		expect(loadCount(outcome.program.functions[0]!)).toBe(1);
		expect(loadCount(outcome.program.functions[1]!)).toBe(2);
	});

	it("invalidates GVN across environment and derived-this rebinding", () => {
		const captured = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const capturedEntry = captured.createBlock();
		const [beforeCaptured] = captured.appendInstruction(
			capturedEntry,
			"loadCaptured",
			[],
			{ attributes: { level: -1, index: 0 } },
		);
		captured.appendInstruction(capturedEntry, "envCopy", []);
		const [afterCaptured] = captured.appendInstruction(
			capturedEntry,
			"loadCaptured",
			[],
			{ attributes: { level: -1, index: 0 } },
		);
		const [capturedSame] = captured.appendInstruction(
			capturedEntry,
			"binary",
			[beforeCaptured!, afterCaptured!],
			{ attributes: { operator: "===" }, outputRepresentations: ["boolean"] },
		);
		captured.setTerminator(capturedEntry, { kind: "return", value: capturedSame! });

		const derived = new CoreFunctionBuilder(1, coreOpcodeRegistry, { parameterCount: 2 });
		const derivedEntry = derived.createBlock([{}, {}]);
		const [parent, argumentsArray] = derived
			.block(derivedEntry)
			.parameters.map(({ value }) => value);
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

		const outcome = executeCoreOptimizations(
			coreProgram([captured.finish(capturedEntry), derived.finish(derivedEntry)]),
		);
		const count = (functionIndex: number, opcode: string) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(
				({ instructions }) => instructions,
			).filter((instruction) => instruction.opcode === opcode).length;
		expect(count(0, "loadCaptured")).toBe(2);
		expect(count(1, "loadThis")).toBe(2);
	});

	it("prunes an exceptional edge as soon as a value pass removes its last throw", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception" }]);
		const [left] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 20 },
			outputRepresentations: ["f64"],
		});
		const [right] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 22 },
			outputRepresentations: ["f64"],
		});
		const [sum] = builder.appendInstruction(entry, "binary", [left!, right!], {
			attributes: { operator: "+" },
			outputRepresentations: ["f64"],
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "return", value: sum! });
		builder.setTerminator(handler, {
			kind: "throw",
			value: builder.block(handler).parameters[0]!.value,
		});

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			verification: "per-pass",
		});
		expect(outcome.program.functions[0]!.blocks).toHaveLength(1);
		expect(outcome.program.functions[0]!.blocks[0]!.handler).toBeUndefined();
	});

	it("applies only representation-proven algebraic identities", () => {
		const buildNumeric = (
			functionIndex: number,
			operator: string,
			constantValue: number | undefined,
			options: { readonly self?: boolean; readonly constantLeft?: boolean } = {},
		): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const condition = builder.block(entry).parameters[0]!.value;
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock([{ representation: "f64" }]);
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			const [leftValue] = builder.appendInstruction(left, "createF64", [], {
				attributes: { value: -2 },
				outputRepresentations: ["f64"],
			});
			const [rightValue] = builder.appendInstruction(right, "createF64", [], {
				attributes: { value: 3 },
				outputRepresentations: ["f64"],
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [leftValue!] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [rightValue!] },
			});
			const dynamic = builder.block(join).parameters[0]!.value;
			let constant = dynamic;
			if (constantValue !== undefined) {
				const [created] = builder.appendInstruction(join, "createF64", [], {
					attributes: { value: constantValue },
					outputRepresentations: ["f64"],
				});
				constant = created!;
			}
			const comparison = ["<", "<=", ">", ">="].includes(operator);
			const inputs = options.self
				? [dynamic, dynamic]
				: options.constantLeft
					? [constant, dynamic]
					: [dynamic, constant];
			const [result] = builder.appendInstruction(join, "binary", inputs, {
				attributes: { operator },
				outputRepresentations: [comparison ? "boolean" : "f64"],
			});
			builder.setTerminator(join, { kind: "return", value: result! });
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			coreProgram([
				buildNumeric(0, "+", -0),
				// +0 is intentionally not an additive identity because -0 + +0 is +0.
				buildNumeric(1, "+", 0),
				buildNumeric(2, "*", 1),
				buildNumeric(3, "&", 0),
				buildNumeric(4, "<", undefined, { self: true }),
				buildNumeric(5, "<", 5, { constantLeft: true }),
			]),
		);
		const binaries = (functionIndex: number) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(
				({ instructions }) => instructions,
			).filter(({ opcode }) => opcode === "binary");
		expect(binaries(0)).toHaveLength(0);
		expect(binaries(1)).toHaveLength(1);
		expect(binaries(2)).toHaveLength(0);
		expect(binaries(3)).toHaveLength(0);
		expect(binaries(4)).toHaveLength(0);
		expect(binaries(5)).toContainEqual(
			expect.objectContaining({ attributes: { operator: ">" } }),
		);
		const returnConstant = (functionIndex: number) => {
			const fn = outcome.program.functions[functionIndex]!;
			const terminator = fn.blocks.find(
				({ terminator }) => terminator.kind === "return",
			)!.terminator;
			if (terminator.kind !== "return") throw new Error("expected algebraic return");
			return fn.blocks
				.flatMap(({ instructions }) => instructions)
				.find(({ outputs }) => outputs.includes(terminator.value));
		};
		expect(returnConstant(3)).toMatchObject({
			opcode: "createF64",
			attributes: { value: 0 },
		});
		expect(returnConstant(4)).toMatchObject({
			opcode: "createBoolean",
			attributes: { value: false },
		});
	});

	it("re-infers numeric joins exposed by optimization before algebraic rewriting", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftValue] = builder.appendInstruction(left, "createF64", [], {
			attributes: { value: -2 },
			outputRepresentations: ["f64"],
		});
		const [rightValue] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 3 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftValue!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightValue!] },
		});
		const joined = builder.appendBlockParameter(join);
		const [negativeZero] = builder.appendInstruction(join, "createF64", [], {
			attributes: { value: -0 },
			outputRepresentations: ["f64"],
		});
		const [sum] = builder.appendInstruction(join, "binary", [joined, negativeZero!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(join, { kind: "return", value: sum! });

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			verification: "per-pass",
		});
		const fn = outcome.program.functions[0]!;
		expect(fn.values.find(({ id }) => id === joined)?.representation).toBe("f64");
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.some(
					({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
				),
		).toBe(false);
		expect([...coreRegisterClasses(fn).registerRepresentations.values()]).toContain(
			"f64",
		);
	});

	it("eliminates a deep dead value graph in one liveness pass", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
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
		builder.setTerminator(entry, { kind: "return", value: returned! });

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			maxRounds: 1,
		});
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "dead-instruction-elimination" && changed,
			),
		).toBe(true);
		expect(fn.blocks[0]!.instructions).toEqual([
			expect.objectContaining({ opcode: "createUndefined", outputs: [returned] }),
		]);
		expect(fn.values.some(({ id }) => id === dead)).toBe(false);
	});

	it("retains observable allocation and call effects when their results are unused", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "createObject", []);
		builder.appendInstruction(entry, "call", [callee!, callee!]);
		builder.setTerminator(entry, { kind: "return", value: callee! });

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks[0]!.instructions.map(({ opcode }) => opcode)).toEqual([
			"createUndefined",
			"createObject",
			"call",
		]);
	});

	it("removes a dead guard and its proof after pure arms reconverge", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const exit = builder.createBlock();
		builder.setGuardTerminator(entry, {
			condition,
			success: { block: exit, arguments: [] },
			fallback: { block: exit, arguments: [] },
			fact: { kind: "unused-proof", value: true, origin: "dce-test" },
		});
		builder.addFact({
			kind: "unused-summary",
			value: true,
			validity: { kind: "summary", digest: "unused-dce-test" },
			obligations: [],
			origin: "dce-test",
		});
		builder.setTerminator(exit, { kind: "return", value: condition });

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks.flatMap(({ terminator }) => terminator.kind)).not.toContain("guard");
		expect(fn.facts).toEqual([]);
	});

	it("folds exact string property keys on the development Core path", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"function read(object) { object.answer = 1; return object.answer; }",
			"core-static-property.js",
		);
		let opcodes: Array<string> = [];
		compileSemanticProgramToVmDefinition(semantic, {
			optimization: "development",
			afterCoreOptimization(program) {
				opcodes = program.functions.flatMap((fn) =>
					fn.blocks.flatMap((block) => block.instructions.map(({ opcode }) => opcode)),
				);
			},
		});

		expect(opcodes).toContain("storePropertyStatic");
		expect(opcodes).toContain("loadPropertyStatic");
	});

	it("attaches guarded builtin identity and semantics to Core calls", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"function append(array, value) { array.push(value); }",
			"core-known-builtin.js",
		);
		let call: CoreFunction["blocks"][number]["instructions"][number] | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				call = program.functions
					.flatMap(({ blocks }) => blocks)
					.flatMap(({ instructions }) => instructions)
					.find(({ opcode }) => opcode === "call");
			},
		});

		expect(call?.attributes.knownBuiltinCall).toMatchObject({
			operation: "Array.prototype.push",
			identity: {
				kind: "known",
				proof: {
					dependencies: [{ kind: "world", fact: "primordials.locked" }],
					obligations: [{ kind: "fallback" }],
				},
			},
			semantics: {
				kind: "known",
				value: { result: "array-length" },
			},
		});
	});

	it("erases exact primitive builtin dispatch only with a locked-world proof", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			'function first() { return "alpha,beta".split(",")[0]; }',
			"core-exact-builtin.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const instructions = optimized!.functions[1]!.blocks.flatMap(
			({ instructions: blockInstructions }) => blockInstructions,
		);
		const builtin = instructions.find(({ opcode }) => opcode === "callBuiltin");
		expect(builtin).toBeDefined();
		expect(builtin?.attributes.operation).toBe("String.prototype.split");
		expect(
			instructions.some((instruction) => {
				const index = instruction.attributes.stringIndex;
				return (
					instruction.opcode === "loadPropertyStatic" &&
					typeof index === "number" &&
					String.fromCharCode(...optimized!.stringConstants[index]!) === "split"
				);
			}),
		).toBe(false);
	});

	it("inlines an exact linear closure while retaining its source chain", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer(value) {
				function addOne(input) { return input + 1; }
				return addOne(value);
			}`,
			"core-inline.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			profile: true,
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const outer = optimized!.functions[1]!;
		expect(
			outer.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "call"),
		).toBe(false);
		const binary = outer.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ opcode }) => opcode === "binary")!;
		expect(optimized!.sourcePositions[binary.sourcePosition!]).toMatchObject({
			inlinedFunctionIndex: 2,
		});
		expect(optimized!.compilation?.optimizationDecisions).toContainEqual(
			expect.objectContaining({
				functionIndex: 1,
				code: "optimization.applied.inline",
				outcome: "applied",
			}),
		);
	});

	it("does not inline an activation whose bindings escape into an inner closure", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer(input) {
				function valuesOf(value) {
					return Object.keys(value).map((key) => value[key]);
				}
				return valuesOf(input);
			}`,
			"core-inline-captured-activation.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			profile: true,
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const outer = optimized!.functions[1]!;
		expect(
			outer.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "call"),
		).toBe(true);
		expect(optimized!.compilation?.optimizationDecisions).toContainEqual(
			expect.objectContaining({
				functionIndex: 1,
				code: "optimization.declined.inner-closure",
				outcome: "declined",
				reason: "inner-closure",
			}),
		);
	});

	it("does not relocate argument reads into the caller activation", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`
			function nested(value) {
				function inner() { return arguments.length; }
				return value + inner(1, 2);
			}
			nested(3);
			`,
			"core-inline-arguments.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const caller = optimized!.functions[1]!;
		const callee = optimized!.functions[2]!;
		expect(
			caller.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "call"),
		).toBe(true);
		expect(
			caller.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "loadArgumentCount"),
		).toBe(false);
		expect(
			callee.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "loadArgumentCount"),
		).toBe(true);
	});

	it("selects a fixed-shape Core stack object with explicit materialization", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function choose(value, escape) {
				const object = { value };
				if (escape) return object;
				return object.value;
			}`,
			"core-stack-object.js",
		);
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			profile: true,
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		expect(optimized!.functions[1]!.regions).toContainEqual(
			expect.objectContaining({ kind: "stack-object-plan" }),
		);
		expect(definition.functions[1]!.regions).toContainEqual(
			expect.objectContaining({
				kind: "stack-object-plan",
				sites: [expect.objectContaining({ materializations: [expect.any(Object)] })],
			}),
		);
		expect(definition.profileRemarks).toContainEqual(
			expect.objectContaining({
				code: "optimization.applied.partial-escape-materialization",
			}),
		);
	});

	it("rejects a stack object that enters a mixed-value join", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function choose(value, useObject) {
				let result = value;
				if (useObject) result = { kind: "chosen", value };
				return result;
			}`,
			"core-stack-object-mixed-join.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		expect(
			optimized!.functions[1]!.regions.some(({ kind }) => kind === "stack-object-plan"),
		).toBe(false);
	});

	it("guards one inherited read before using activation-local object slots", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(value) {
				const object = { value };
				const inherited = object.toString;
				return object.value + (typeof inherited === "function" ? 1 : 0);
			}`,
			"core-stack-object-inherited.js",
		);
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const coreRegion = optimized!.functions[1]!.regions.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(coreRegion?.data).toMatchObject({
			license: {
				guard: {
					dependencies: [expect.objectContaining({ kind: "epoch" })],
				},
				materialization: "on-demand",
			},
		});
		expect(JSON.stringify(coreRegion?.data)).toMatch(
			/"inheritedAccess":\{"\$coreInstruction":\d+\}/,
		);
		const vmRegion = definition.functions[1]!.regions?.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(vmRegion?.license.materialization).toBe("on-demand");
		if (vmRegion?.kind !== "stack-object-plan") throw new Error("expected stack region");
		expect(typeof vmRegion.sites[0]!.inheritedAccessIp).toBe("number");
	});

	it("certifies a fully local stack object without a materializer", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(value) {
				const object = { value };
				return object.value;
			}`,
			"core-local-stack-object.js",
		);
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const coreRegion = optimized!.functions[1]!.regions.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(coreRegion?.data).toMatchObject({
			license: {
				guard: { obligations: [{ kind: "fallback" }] },
				materialization: "none",
			},
			sites: [{ materializations: [] }],
		});

		const restored = deserializeVmDefinition(serializeVmDefinition(definition));
		const vmRegion = restored.functions[1]!.regions?.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(vmRegion?.kind).toBe("stack-object-plan");
		if (vmRegion?.kind !== "stack-object-plan") throw new Error("expected stack region");
		expect(vmRegion.license.materialization).toBe("none");
		expect(vmRegion.sites).toHaveLength(1);
		expect(vmRegion.sites[0]!.materializations).toEqual([]);
	});

	it("preserves every selected region beyond the former fixed VM ceiling", () => {
		const declarations = Array.from(
			{ length: 41 },
			(_, index) =>
				`const object${index} = { value: values[${index}] };
				total += object${index}.value;`,
		).join("\n");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function many(values) {
				let total = 0;
				${declarations}
				return total;
			}`,
			"core-many-regions.js",
		);
		const definition = compileSemanticProgramToVmDefinition(semantic);
		const regions = definition.functions[1]!.regions!;

		expect(regions.length).toBeGreaterThan(40);
		expect(regions.filter(({ kind }) => kind === "stack-object-plan")).toHaveLength(41);
		expect(
			deserializeVmDefinition(serializeVmDefinition(definition)).functions[1]!.regions,
		).toEqual(regions);
	});

	it("certifies only closed String.split projections", () => {
		const compile = (body: string): CoreProgram => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				`function project(value) { ${body} }`,
				"core-string-split.js",
			);
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToVmDefinition(semantic, {
				afterCoreOptimization(program) {
					optimized = program;
				},
			});
			return optimized!;
		};

		const closed = compile(
			'const fields = value.split(";"); return fields[1] + fields.length;',
		);
		const regions = closed.functions[1]!.regions.filter(
			({ kind }) => kind === "string-split-projection",
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({
			kind: "string-split-projection",
			data: {
				license: {
					genericTwin: "retained",
					materialization: "whole-region",
				},
				representation: "projected-elements",
			},
		});
		const obligations = (
			regions[0]!.data.license as {
				readonly guard: { readonly obligations: ReadonlyArray<unknown> };
			}
		).guard.obligations;
		expect(obligations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "fallback" }),
				expect.objectContaining({ kind: "materialize" }),
			]),
		);

		const escaping = compile('return value.split(";");');
		expect(
			escaping.functions[1]!.regions.some(
				({ kind }) => kind === "string-split-projection",
			),
		).toBe(false);
	});

	it("folds exact object observations before selecting partial escape regions", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function choose(value, escape) {
				const object = { value };
				const alias = object;
				if (escape) return alias;
				return typeof object === "object" && object === alias
					? object.value
					: -1;
			}`,
			"core-stack-object-observations.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const fn = optimized!.functions[1]!;
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.some(
					(instruction) =>
						instruction.opcode === "unary" &&
						instruction.attributes.operator === "typeof",
				),
		).toBe(false);
		const region = fn.regions.find(({ kind }) => kind === "stack-object-plan");
		expect(region).toBeDefined();
		expect(region!.data).toMatchObject({
			sites: [expect.objectContaining({ materializations: [expect.any(Object)] })],
		});
	});

	it("removes TDZ checks only when Core SSA excludes the Empty sentinel", () => {
		const optimizedOpcodes = (source: string): Array<string> => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(source, "core-tdz.js");
			let opcodes: Array<string> = [];
			compileSemanticProgramToVmDefinition(semantic, {
				afterCoreOptimization(program) {
					opcodes = program.functions.flatMap((fn) =>
						fn.blocks.flatMap((block) => block.instructions.map(({ opcode }) => opcode)),
					);
				},
			});
			return opcodes;
		};
		const safe = optimizedOpcodes(`
			function safe(object) {
				let errors = 0;
				try { object.x; } catch { errors = errors + 1; }
				return errors + 1;
			}
		`);
		const unsafe = optimizedOpcodes(`
			function unsafe() { return value; let value = 1; }
		`);

		expect(safe).not.toContain("throwIfTdz");
		expect(unsafe).toContain("throwIfTdz");
	});

	it("folds primitive arithmetic with exact f64 edge semantics", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
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
		});
		const [infinity] = builder.appendInstruction(entry, "binary", [one!, zero!], {
			attributes: { operator: "/" },
		});
		const [equal] = builder.appendInstruction(entry, "binary", [nan!, infinity!], {
			attributes: { operator: "===" },
		});
		builder.setTerminator(entry, { kind: "return", value: equal! });

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks[0]!.instructions).toHaveLength(1);
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "createBoolean",
			attributes: { value: false },
		});
		expect(fn.values.find(({ id }) => id === equal)?.representation).toBe("boolean");
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("folds primitive control and removes unreachable blocks", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const dead = builder.createBlock();
		const body = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: dead, arguments: [] },
		});
		const [deadValue] = builder.appendInstruction(dead, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.setTerminator(dead, { kind: "return", value: deadValue! });
		const [result] = builder.appendInstruction(body, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(body, { kind: "return", value: result! });
		const original = builder.finish(entry);
		const program = coreProgram([{ ...original, bodyEntry: body }]);

		const fn = executeCoreOptimizations(program).program.functions[0]!;
		expect(fn.blocks).toHaveLength(2);
		expect(fn.bodyEntry).toBe(1);
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "jump",
			edge: { block: 1 },
		});
		expect(fn.blocks[0]!.instructions).toHaveLength(0);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("folds a primitive switch with JavaScript strict equality", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const one = builder.createBlock();
		const two = builder.createBlock();
		const fallback = builder.createBlock();
		const [discriminant] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(entry, {
			kind: "switch",
			discriminant: discriminant!,
			cases: [
				{ value: { kind: "number", value: 1 }, edge: { block: one, arguments: [] } },
				{ value: { kind: "number", value: 2 }, edge: { block: two, arguments: [] } },
			],
			default: { block: fallback, arguments: [] },
		});
		for (const [block, value] of [
			[one, 1],
			[two, 2],
			[fallback, 3],
		] as const) {
			const [result] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value },
			});
			builder.setTerminator(block, { kind: "return", value: result! });
		}

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks).toHaveLength(1);
		expect(fn.blocks[0]!.terminator).toMatchObject({ kind: "return" });
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "createNumber",
			attributes: { value: 2 },
		});
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("combines linear SSA blocks by substituting edge arguments", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.block(entry).parameters[0]!.value;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [parameter] },
		});
		const bodyParameter = builder.block(body).parameters[0]!.value;
		const [result] = builder.appendInstruction(body, "call", [
			bodyParameter,
			bodyParameter,
		]);
		builder.setTerminator(body, { kind: "return", value: result! });

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)])).program
			.functions[0]!;
		expect(fn.blocks).toHaveLength(1);
		expect(fn.blocks[0]!.instructions[0]).toMatchObject({
			opcode: "call",
			inputs: [parameter, parameter],
		});
		expect(fn.values).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: bodyParameter })]),
		);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("optimizes outside a region while preserving its claimed instruction slice", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [result] = builder.appendInstruction(entry, "call", [callee!, callee!]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const complete = builder.finish(entry);
		const call = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.opcode === "call",
		)!;
		const protectedFunction = {
			...complete,
			regions: [
				{
					kind: "test-certificate",
					anchors: [call.id],
					claimedInstructions: [call.id],
					ordinaryBlocks: [entry],
					exceptionalBlocks: [],
					data: { call: { $coreInstruction: call.id } },
				},
			],
		};

		const optimized = executeCoreOptimizations(coreProgram([protectedFunction])).program
			.functions[0]!;
		const optimizedCall = optimized.blocks[0]!.instructions.find(
			(instruction) => instruction.id === call.id,
		);

		expect(optimizedCall).toEqual(call);
		expect(
			optimized.blocks[0]!.instructions.filter(
				(instruction) => instruction.opcode === "createNumber",
			),
		).toHaveLength(0);
		expect(() => verifyCoreFunction(optimized, coreOpcodeRegistry)).not.toThrow();
	});

	it("rejects a pass result that mutates a claimed instruction", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [dead] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [result] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const complete = builder.finish(entry);
		const claimed = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.outputs[0] === dead,
		)!;
		const protectedFunction = {
			...complete,
			regions: [
				{
					kind: "test-certificate",
					anchors: [claimed.id],
					claimedInstructions: [claimed.id],
					ordinaryBlocks: [entry],
					exceptionalBlocks: [],
					data: { producer: { $coreInstruction: claimed.id } },
				},
			],
		};

		const optimized = executeCoreOptimizations(coreProgram([protectedFunction])).program
			.functions[0]!;

		expect(
			optimized.blocks[0]!.instructions.find(
				(instruction) => instruction.id === claimed.id,
			),
		).toEqual(claimed);
		expect(() => verifyCoreFunction(optimized, coreOpcodeRegistry)).not.toThrow();
	});
});
