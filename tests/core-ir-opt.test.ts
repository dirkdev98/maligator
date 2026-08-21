import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	buildCoreControlFlow,
	coreTerminatorEdges,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CoreAnalysisManager,
	coreOptimizationMetrics,
	executeCoreOptimizations,
} from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import { CORE_NO_EFFECTS, CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type { CoreFunction, CoreProgram } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	coreRegisterClasses,
	lowerCoreProgramToTarget,
} from "../src/compiler/target/core-target-lowering.ts";
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

function globalLoadCount(fn: CoreFunction): number {
	return fn.blocks
		.flatMap(({ instructions }) => instructions)
		.filter(({ opcode }) => opcode === "loadGlobal").length;
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
			claims: [],
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
			fact: { kind: "metrics-guard", value: true, claims: [], origin: "metrics-test" },
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

	it("retains both paths when an executable join stops being constant", () => {
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
		const [rightFalse] = builder.appendInstruction(right, "createBoolean", [], {
			attributes: { value: false },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftTrue!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightFalse!] },
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

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			verification: "per-pass",
		}).program.functions[0]!;
		const branches = fn.blocks
			.map(({ terminator }) => terminator)
			.filter((terminator) => terminator.kind === "branch");
		expect(branches).toHaveLength(1);
		expect(branches[0]!.consequent.block).not.toBe(branches[0]!.alternate.block);
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(({ opcode }) => opcode === "createNumber")
				.map(({ attributes }) => attributes.value)
				.sort(),
		).toEqual([0, 1]);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
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

	it("keeps distinct memory versions around a conditional store in a loop", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 2,
		});
		const entry = builder.createBlock([{}, {}]);
		const [storeCondition, repeatCondition] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
		const header = builder.createBlock();
		const store = builder.createBlock();
		const skip = builder.createBlock();
		const join = builder.createBlock();
		const exit = builder.createBlock();
		const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [before] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(header, "storeLocal", [before!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: storeCondition!,
			consequent: { block: store, arguments: [] },
			alternate: { block: skip, arguments: [] },
		});
		builder.appendInstruction(store, "storeGlobal", [replacement!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(store, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		builder.setTerminator(skip, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		const [after] = builder.appendInstruction(join, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(join, {
			kind: "branch",
			condition: repeatCondition!,
			consequent: { block: header, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: after! });

		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 1 },
			{ verification: "per-pass" },
		).program.functions[0]!;
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(({ opcode }) => opcode === "loadGlobal"),
		).toHaveLength(2);
	});

	it("keeps memory versions distinct across a loop with two backedges", () => {
		const build = (functionIndex: number, writeInLoop: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 2,
			});
			const entry = builder.createBlock([{}, {}]);
			const [armCondition, repeatCondition] = builder
				.block(entry)
				.parameters.map(({ value }) => value);
			const header = builder.createBlock();
			const left = builder.createBlock();
			const right = builder.createBlock();
			const exit = builder.createBlock();
			const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: header, arguments: [] },
			});
			const [before] = builder.appendInstruction(header, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.appendInstruction(header, "storeLocal", [before!], {
				attributes: { index: 0 },
			});
			builder.setTerminator(header, {
				kind: "branch",
				condition: armCondition!,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			if (writeInLoop) {
				builder.appendInstruction(left, "storeGlobal", [replacement!], {
					attributes: { index: 0 },
				});
			}
			for (const arm of [left, right]) {
				builder.setTerminator(arm, {
					kind: "branch",
					condition: repeatCondition!,
					consequent: { block: header, arguments: [] },
					alternate: { block: exit, arguments: [] },
				});
			}
			const [after] = builder.appendInstruction(exit, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(exit, { kind: "return", value: after! });
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			{ ...coreProgram([build(0, false), build(1, true)]), globalCount: 1 },
			{ verification: "per-pass" },
		);
		expect(globalLoadCount(outcome.program.functions[0]!)).toBe(1);
		expect(globalLoadCount(outcome.program.functions[1]!)).toBe(2);
	});

	it("versions a slot through a chain of joins without inventing a phi", () => {
		const build = (functionIndex: number, writeInChain: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const condition = builder.block(entry).parameters[0]!.value;
			const [replacement] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const [before] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.appendInstruction(entry, "storeLocal", [before!], {
				attributes: { index: 0 },
			});
			let current = entry;
			for (const diamond of [0, 1, 2]) {
				const left = builder.createBlock();
				const right = builder.createBlock();
				const join = builder.createBlock();
				builder.setTerminator(current, {
					kind: "branch",
					condition,
					consequent: { block: left, arguments: [] },
					alternate: { block: right, arguments: [] },
				});
				if (writeInChain && diamond === 1) {
					builder.appendInstruction(left, "storeGlobal", [replacement!], {
						attributes: { index: 0 },
					});
				}
				builder.setTerminator(left, {
					kind: "jump",
					edge: { block: join, arguments: [] },
				});
				builder.setTerminator(right, {
					kind: "jump",
					edge: { block: join, arguments: [] },
				});
				current = join;
			}
			const [after] = builder.appendInstruction(current, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(current, { kind: "return", value: after! });
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			{ ...coreProgram([build(0, false), build(1, true)]), globalCount: 1 },
			{ verification: "per-pass" },
		);
		expect(globalLoadCount(outcome.program.functions[0]!)).toBe(1);
		expect(globalLoadCount(outcome.program.functions[1]!)).toBe(2);
	});

	it("spends the memory family precision bound only on exactly read slots", () => {
		const writeOnlySlots = 300;
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const stored = builder.block(entry).parameters[0]!.value;
		builder.appendInstruction(entry, "storeGlobal", [stored], {
			attributes: { index: 0 },
		});
		// Slots nothing reads never reach the solver, so they must not push the
		// family past the bound and cost slot 0 its exact partition.
		for (let slot = 1; slot <= writeOnlySlots; slot += 1) {
			builder.appendInstruction(entry, "storeGlobal", [stored], {
				attributes: { index: slot },
			});
		}
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const fn = executeCoreOptimizations(
			{
				...coreProgram([builder.finish(entry)]),
				globalCount: writeOnlySlots + 1,
			},
			{ verification: "per-pass" },
		).program.functions[0]!;
		expect(globalLoadCount(fn)).toBe(0);
		expect(fn.blocks.at(-1)!.terminator).toMatchObject({
			kind: "return",
			value: fn.parameters[0],
		});
	});

	it("falls back to the domain once a family exceeds its exactly read bound", () => {
		const build = (functionIndex: number, slots: number): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			let carried = builder.block(entry).parameters[0]!.value;
			for (let slot = 0; slot < slots; slot += 1) {
				builder.appendInstruction(entry, "storeGlobal", [carried], {
					attributes: { index: slot },
				});
				const [reloaded] = builder.appendInstruction(entry, "loadGlobal", [], {
					attributes: { index: slot },
				});
				carried = reloaded!;
			}
			builder.setTerminator(entry, { kind: "return", value: carried });
			return builder.finish(entry);
		};
		const overBound = 300;
		const outcome = executeCoreOptimizations(
			{ ...coreProgram([build(0, 8), build(1, overBound)]), globalCount: overBound },
			{ verification: "per-pass" },
		);
		expect(globalLoadCount(outcome.program.functions[0]!)).toBe(0);
		expect(globalLoadCount(outcome.program.functions[1]!)).toBe(overBound);
	});

	it("forwards present array elements across numeric and string key aliases", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(seed) {
				const values = [seed];
				const before = values[0];
				values["0"] = seed + 1;
				return before + values[0] + values.length + values.length;
			}`,
			"core-array-element-aliases.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const loads = optimized!.functions[1]!.blocks.flatMap(
			({ instructions }) => instructions,
		).filter(
			({ opcode }) => opcode === "loadProperty" || opcode === "loadPropertyStatic",
		);
		expect(loads).toHaveLength(1);
		const stringIndex = loads[0]!.attributes.stringIndex;
		expect(
			typeof stringIndex === "number"
				? String.fromCharCode(...optimized!.stringConstants[stringIndex]!)
				: undefined,
		).toBe("length");
	});

	it("retains repeated hole reads that can reach an inherited accessor", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(seed) {
				const values = [seed, ,];
				return values[1] + values[1];
			}`,
			"core-array-hole-reads.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		expect(
			optimized!.functions[1]!.blocks.flatMap(({ instructions }) => instructions).filter(
				({ opcode }) => opcode === "loadProperty" || opcode === "loadPropertyStatic",
			),
		).toHaveLength(2);
	});

	it("removes unobservable primitive stores to a private array element", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function write(seed) {
				const values = [seed > 0];
				values[0] = seed + 1;
				values["0"] = seed + 2;
				return seed;
			}`,
			"core-array-dead-stores.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		expect(
			optimized!.functions[1]!.blocks.flatMap(({ instructions }) => instructions).filter(
				({ opcode }) =>
					["defineProperty", "storeProperty", "storePropertyStatic"].includes(opcode),
			),
		).toHaveLength(0);
	});

	it("forwards a compiler-slot store to a dominated load", () => {
		const build = (
			functionIndex: number,
			barrier: "none" | "call" | "suspend",
		): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
				isGenerator: barrier === "suspend",
			});
			const entry = builder.createBlock([{}]);
			const stored = builder.block(entry).parameters[0]!.value;
			if (barrier === "suspend") builder.appendInstruction(entry, "generatorStart", []);
			builder.appendInstruction(entry, "storeGlobal", [stored], {
				attributes: { index: 0 },
			});
			if (barrier === "call") {
				const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
					attributes: { intrinsic: "Object" },
				});
				builder.appendInstruction(entry, "call", [callee!, stored]);
			}
			if (barrier === "suspend") {
				builder.appendInstruction(entry, "yield", [stored], { outputCount: 2 });
			}
			const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			return builder.finish(entry);
		};
		// A scope-chain edit rebinds captured cells, not global slots, so the
		// captured variant is the one that must stop at `envCopy`.
		const buildCaptured = (functionIndex: number, edited: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const stored = builder.block(entry).parameters[0]!.value;
			builder.appendInstruction(entry, "storeCaptured", [stored], {
				attributes: { functionIndex: 0, index: 2 },
			});
			if (edited) {
				builder.appendInstruction(entry, "envCopy", [], {
					attributes: { scopeId: -1, slotCount: 1 },
				});
			}
			const [loaded] = builder.appendInstruction(entry, "loadCaptured", [], {
				attributes: { functionIndex: 0, index: 2 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			{
				...coreProgram([
					build(0, "none"),
					build(1, "call"),
					build(2, "suspend"),
					buildCaptured(3, false),
					buildCaptured(4, true),
				]),
				globalCount: 1,
			},
			{ verification: "per-pass" },
		);
		const loads = (functionIndex: number, opcode: string) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.filter((instruction) => instruction.opcode === opcode),
			).length;
		expect(loads(0, "loadGlobal")).toBe(0);
		expect(loads(1, "loadGlobal")).toBe(1);
		expect(loads(2, "loadGlobal")).toBe(1);
		expect(loads(3, "loadCaptured")).toBe(0);
		expect(loads(4, "loadCaptured")).toBe(1);
		// The forwarded function returns the stored parameter itself.
		const forwarded = outcome.program.functions[0]!;
		expect(forwarded.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: forwarded.parameters[0],
		});
	});

	it("keeps one exact slot available across a store to a different slot", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 2,
		});
		const entry = builder.createBlock([{}, {}]);
		const [kept, other] = builder.block(entry).parameters.map(({ value }) => value);
		builder.appendInstruction(entry, "storeGlobal", [kept!], {
			attributes: { index: 0 },
		});
		builder.appendInstruction(entry, "storeCaptured", [other!], {
			attributes: { functionIndex: 0, index: 3 },
		});
		builder.appendInstruction(entry, "storeGlobal", [other!], {
			attributes: { index: 1 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 2 },
			{ verification: "per-pass" },
		).program.functions[0]!;
		expect(
			fn.blocks.flatMap(({ instructions }) => instructions).map(({ opcode }) => opcode),
		).not.toContain("loadGlobal");
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: fn.parameters[0],
		});
	});

	it("does not forward a slot into a handler or around an irreducible cycle", () => {
		const guarded = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const guardedEntry = guarded.createBlock([{}]);
		const handler = guarded.createBlock([{ role: "exception" }]);
		const stored = guarded.block(guardedEntry).parameters[0]!.value;
		guarded.appendInstruction(guardedEntry, "storeGlobal", [stored], {
			attributes: { index: 0 },
		});
		const [callee] = guarded.appendInstruction(guardedEntry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Object" },
		});
		guarded.appendInstruction(guardedEntry, "call", [callee!, stored]);
		guarded.setHandler(guardedEntry, handler);
		guarded.setTerminator(guardedEntry, { kind: "return", value: stored });
		const [rescued] = guarded.appendInstruction(handler, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		guarded.setTerminator(handler, { kind: "return", value: rescued! });

		// Two mutually reachable blocks with no dominating header: neither entry
		// version is a pass-through, so no slot value crosses the cycle.
		const irreducible = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			parameterCount: 2,
		});
		const irreducibleEntry = irreducible.createBlock([{}, {}]);
		const left = irreducible.createBlock();
		const right = irreducible.createBlock();
		const exit = irreducible.createBlock();
		const [value, condition] = irreducible
			.block(irreducibleEntry)
			.parameters.map(({ value: parameter }) => parameter);
		irreducible.appendInstruction(irreducibleEntry, "storeGlobal", [value!], {
			attributes: { index: 0 },
		});
		irreducible.setTerminator(irreducibleEntry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [fromLeft] = irreducible.appendInstruction(left, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		irreducible.appendInstruction(left, "storeGlobal", [fromLeft!], {
			attributes: { index: 1 },
		});
		irreducible.setTerminator(left, {
			kind: "branch",
			condition: condition!,
			consequent: { block: right, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [fromRight] = irreducible.appendInstruction(right, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		irreducible.appendInstruction(right, "storeGlobal", [fromRight!], {
			attributes: { index: 0 },
		});
		irreducible.setTerminator(right, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		irreducible.setTerminator(exit, { kind: "return", value: value! });

		const outcome = executeCoreOptimizations(
			{
				...coreProgram([
					guarded.finish(guardedEntry),
					irreducible.finish(irreducibleEntry),
				]),
				globalCount: 2,
			},
			{ verification: "per-pass" },
		);
		const loads = (functionIndex: number) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "loadGlobal"),
			).length;
		expect(loads(0)).toBe(1);
		expect(loads(1)).toBe(2);
	});

	it("leaves a forwarded slot value to the ordinary TDZ proof", () => {
		const build = (functionIndex: number, initialized: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const parameter = builder.block(entry).parameters[0]!.value;
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
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			{ ...coreProgram([build(0, true), build(1, false)]), globalCount: 1 },
			{ verification: "per-pass" },
		);
		const opcodes = (functionIndex: number) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.map(({ opcode }) => opcode),
			);
		// Forwarding a definitely-initialized value lets the existing Empty-provenance
		// proof retire the check; forwarding a possible Empty sentinel must not.
		expect(opcodes(0)).not.toContain("throwIfTdz");
		expect(opcodes(1)).toContain("throwIfTdz");
	});

	it("forwards own data slots of a contained shaped literal", () => {
		// { f0: a, f1: b }; o.f1 = a; return o.f0 + o.f1
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const [first, second] = builder.block(entry).parameters.map(({ value }) => value);
		const [object] = builder.appendInstruction(
			entry,
			"createObjectShaped",
			[first!, second!],
			{ attributes: { keyStringIndices: [1, 2] } },
		);
		builder.appendInstruction(entry, "storePropertyStatic", [object!, first!], {
			attributes: { stringIndex: 2 },
		});
		const [readFirst] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[object!],
			{
				attributes: { stringIndex: 1 },
			},
		);
		const [readSecond] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[object!],
			{ attributes: { stringIndex: 2 } },
		);
		const [sum] = builder.appendInstruction(entry, "binary", [readFirst!, readSecond!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(entry, { kind: "return", value: sum! });
		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), stringConstants: [[], [102], [103]] },
			{ verification: "per-pass" },
		).program.functions[0]!;
		const instructions = fn.blocks.flatMap(({ instructions: list }) => list);
		expect(instructions.map(({ opcode }) => opcode)).not.toContain("loadPropertyStatic");
		// Both reads resolve to the same parameter, so the sum adds it to itself.
		expect(instructions.find(({ opcode }) => opcode === "binary")?.inputs).toStrictEqual([
			fn.parameters[0],
			fn.parameters[0],
		]);
	});

	it("preserves boxing while forwarding a primitive literal slot", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [initial] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 41 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
			attributes: { keyStringIndices: [1] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [sum] = builder.appendInstruction(entry, "binary", [loaded!, one!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(entry, { kind: "return", value: sum! });

		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), stringConstants: [[], [102]] },
			{ verification: "per-pass" },
		).program.functions[0]!;
		expect(
			fn.blocks.flatMap(({ instructions }) => instructions).map(({ opcode }) => opcode),
		).not.toContain("loadPropertyStatic");
	});

	it("prunes a handler when an own-slot proof removes its last possible throw", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const initial = builder.block(entry).parameters[0]!.value;
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial], {
			attributes: { keyStringIndices: [1] },
		});
		const body = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception" }]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: body, arguments: [] },
		});
		const [loaded] = builder.appendInstruction(body, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setHandler(body, handler);
		builder.setTerminator(body, { kind: "return", value: loaded! });
		builder.setTerminator(handler, {
			kind: "throw",
			value: builder.block(handler).parameters[0]!.value,
		});

		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), stringConstants: [[], [102]] },
			{ verification: "per-pass" },
		).program.functions[0]!;
		expect(
			fn.blocks.flatMap(({ instructions }) => instructions).map(({ opcode }) => opcode),
		).not.toContain("loadPropertyStatic");
		expect(fn.blocks.every(({ handler: candidate }) => candidate === undefined)).toBe(
			true,
		);
	});

	it("keeps property accesses a prototype or a foreign reference could observe", () => {
		const build = (
			functionIndex: number,
			variant: "outside-shape" | "returned" | "passed-to-call",
		): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const parameter = builder.block(entry).parameters[0]!.value;
			const [object] = builder.appendInstruction(
				entry,
				"createObjectShaped",
				[parameter],
				{ attributes: { keyStringIndices: [1] } },
			);
			if (variant === "passed-to-call") {
				const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
					attributes: { intrinsic: "Object" },
				});
				builder.appendInstruction(entry, "call", [callee!, parameter, object!]);
			}
			// A key the literal never declared reaches the prototype chain.
			const key = variant === "outside-shape" ? 2 : 1;
			const [firstRead] = builder.appendInstruction(
				entry,
				"loadPropertyStatic",
				[object!],
				{ attributes: { stringIndex: key } },
			);
			const [secondRead] = builder.appendInstruction(
				entry,
				"loadPropertyStatic",
				[object!],
				{ attributes: { stringIndex: key } },
			);
			const [sum] = builder.appendInstruction(
				entry,
				"binary",
				[firstRead!, secondRead!],
				{
					attributes: { operator: "+" },
				},
			);
			builder.setTerminator(entry, {
				kind: "return",
				value: variant === "returned" ? object! : sum!,
			});
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			{
				...coreProgram([
					build(0, "outside-shape"),
					build(1, "returned"),
					build(2, "passed-to-call"),
				]),
				stringConstants: [[], [102], [103]],
			},
			{ verification: "per-pass" },
		);
		for (const fn of outcome.program.functions) {
			expect(
				fn.blocks
					.flatMap(({ instructions }) => instructions)
					.filter(({ opcode }) => opcode === "loadPropertyStatic"),
			).toHaveLength(2);
		}
	});

	it("keeps a contained slot across a call and reloads it after a store", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const parameter = builder.block(entry).parameters[0]!.value;
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [parameter], {
			attributes: { keyStringIndices: [1] },
		});
		const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
			attributes: { intrinsic: "Object" },
		});
		builder.appendInstruction(entry, "call", [callee!, parameter]);
		const [afterCall] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[object!],
			{ attributes: { stringIndex: 1 } },
		);
		builder.appendInstruction(entry, "storePropertyStatic", [object!, afterCall!], {
			attributes: { stringIndex: 1 },
		});
		const [afterStore] = builder.appendInstruction(
			entry,
			"loadPropertyStatic",
			[object!],
			{ attributes: { stringIndex: 1 } },
		);
		builder.setTerminator(entry, { kind: "return", value: afterStore! });
		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), stringConstants: [[], [102]] },
			{ verification: "per-pass" },
		).program.functions[0]!;
		// The call cannot reach a reference this activation never handed out, so the
		// literal's initial value is still the slot's value; the store then makes the
		// following read the stored value, which is that same parameter.
		expect(
			fn.blocks.flatMap(({ instructions }) => instructions).map(({ opcode }) => opcode),
		).not.toContain("loadPropertyStatic");
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: fn.parameters[0],
		});
	});

	it("does not forward across an otherwise universal exact write", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 2,
		});
		const entry = builder.createBlock([{}, {}]);
		const [initial, stored] = builder.block(entry).parameters.map(({ value }) => value);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
			attributes: { keyStringIndices: [1] },
		});
		const proof = builder.addFact({
			kind: "pre-existing-refinement",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "test-pre-existing-refinement" },
			obligations: [],
			origin: "test",
		});
		builder.appendInstruction(entry, "storePropertyStatic", [object!, stored!], {
			attributes: { stringIndex: 1 },
			effectRefinement: {
				effects: coreOpcodeRegistry.require("storePropertyStatic").effects,
				proof,
			},
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), stringConstants: [[], [102]] },
			{ verification: "per-pass" },
		).program.functions[0]!;
		expect(
			fn.blocks.flatMap(({ instructions }) => instructions).map(({ opcode }) => opcode),
		).toContain("loadPropertyStatic");
		expect(fn.blocks[0]!.terminator).not.toMatchObject({ value: fn.parameters[0] });
	});

	it("removes stores to a contained slot nothing reads", () => {
		// Both variants store a proven primitive into a contained literal; only the
		// second has a read that no store dominates, so its stores are the slot's
		// only definition.
		const build = (functionIndex: number, read: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const condition = builder.block(entry).parameters[0]!.value;
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock();
			const [zero] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 0 },
			});
			const [one] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 1 },
			});
			const [object] = builder.appendInstruction(entry, "createObjectShaped", [zero!], {
				attributes: { keyStringIndices: [1] },
			});
			builder.setTerminator(entry, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			builder.appendInstruction(left, "storePropertyStatic", [object!, one!], {
				attributes: { stringIndex: 1 },
			});
			builder.setTerminator(left, { kind: "jump", edge: { block: join, arguments: [] } });
			builder.appendInstruction(right, "storePropertyStatic", [object!, zero!], {
				attributes: { stringIndex: 1 },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			if (!read) {
				builder.setTerminator(join, { kind: "return", value: condition });
				return builder.finish(entry);
			}
			const [loaded] = builder.appendInstruction(join, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 1 },
			});
			builder.setTerminator(join, { kind: "return", value: loaded! });
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			{
				...coreProgram([build(0, false), build(1, true)]),
				stringConstants: [[], [102]],
			},
			{ verification: "per-pass" },
		);
		const count = (functionIndex: number, opcode: string) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.filter((instruction) => instruction.opcode === opcode),
			).length;
		expect(count(0, "storePropertyStatic")).toBe(0);
		// Neither store dominates the join, so both must survive to define the slot
		// the surviving load reads.
		expect(count(1, "storePropertyStatic")).toBe(2);
		expect(count(1, "loadPropertyStatic")).toBe(1);
	});

	it("retains a slot whose values a WeakRef or a registry could observe", () => {
		// Same unread slot as above, but the values that occupy it are not proven
		// primitives, so how long the slot references them stays observable through
		// WeakRef.deref and FinalizationRegistry callbacks.
		const build = (
			functionIndex: number,
			occupant: "parameter" | "number",
		): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const parameter = builder.block(entry).parameters[0]!.value;
			const [initial] =
				occupant === "parameter"
					? [parameter]
					: builder.appendInstruction(entry, "createNumber", [], {
							attributes: { value: 0 },
						});
			const [object] = builder.appendInstruction(
				entry,
				"createObjectShaped",
				[initial!],
				{ attributes: { keyStringIndices: [1] } },
			);
			const [stored] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			builder.appendInstruction(entry, "storePropertyStatic", [object!, stored!], {
				attributes: { stringIndex: 1 },
			});
			builder.setTerminator(entry, { kind: "return", value: parameter });
			return builder.finish(entry);
		};
		const outcome = executeCoreOptimizations(
			{
				...coreProgram([build(0, "parameter"), build(1, "number")]),
				stringConstants: [[], [102]],
			},
			{ verification: "per-pass" },
		);
		const stores = (functionIndex: number) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "storePropertyStatic"),
			).length;
		// The literal's initial value is an unproven reference, so dropping the store
		// that replaced it would keep that reference alive for longer.
		expect(stores(0)).toBe(1);
		// Every value the slot can hold is a number, so its reachability is not
		// observable and the store goes.
		expect(stores(1)).toBe(0);
	});
	it("keeps an overwritten store whose block can transfer to a reader", () => {
		// o.f0 = a; <may throw>; o.f0 = b, with the handler reading the slot. The
		// handler is a reader inside this activation, so the first store is still
		// observable even though a later store overwrites it.
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const [first, second] = builder.block(entry).parameters.map(({ value }) => value);
		const [zero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [zero!], {
			attributes: { keyStringIndices: [1] },
		});
		const body = builder.createBlock();
		const handler = builder.createBlock([{ role: "exception" }]);
		builder.setTerminator(entry, { kind: "jump", edge: { block: body, arguments: [] } });
		builder.appendInstruction(body, "storePropertyStatic", [object!, first!], {
			attributes: { stringIndex: 1 },
		});
		builder.appendInstruction(body, "requireCoercible", [second!]);
		builder.appendInstruction(body, "storePropertyStatic", [object!, second!], {
			attributes: { stringIndex: 1 },
		});
		builder.setHandler(body, handler);
		builder.setTerminator(body, { kind: "return", value: zero! });
		const [rescued] = builder.appendInstruction(
			handler,
			"loadPropertyStatic",
			[object!],
			{
				attributes: { stringIndex: 1 },
			},
		);
		builder.setTerminator(handler, { kind: "return", value: rescued! });
		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), stringConstants: [[], [102]] },
			{ verification: "per-pass" },
		).program.functions[0]!;
		expect(
			fn.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "storePropertyStatic"),
			),
		).toHaveLength(2);
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

	it("does not reuse a protected-block value after an exceptional join", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const handler = builder.createBlock([{ role: "exception" }]);
		const join = builder.createBlock();
		const callee = builder.block(entry).parameters[0]!.value;
		builder.appendInstruction(entry, "call", [callee, callee]);
		builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "jump", edge: { block: join, arguments: [] } });
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		const [result] = builder.appendInstruction(join, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(join, { kind: "return", value: result! });

		expect(() =>
			executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
				verification: "per-pass",
			}),
		).not.toThrow();
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

	it("hoists speculatable loop invariants but keeps identity creation in the loop", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [constant] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [sine] = builder.appendInstruction(body, "mathUnaryNumber", [constant!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [sine!], {
			attributes: { index: 0 },
		});
		const [object] = builder.appendInstruction(body, "createObject", []);
		builder.appendInstruction(body, "storeGlobal", [object!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: condition });

		const outcome = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 1 },
			{ verification: "per-pass" },
		);
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "loop-invariant-code-motion" && changed,
			),
		).toBe(true);
		expect(fn.blocks[entry]!.instructions.map(({ opcode }) => opcode)).toEqual([
			"createF64",
			"mathUnaryNumber",
		]);
		expect(fn.blocks[body]!.instructions.map(({ opcode }) => opcode)).toEqual([
			"storeGlobal",
			"createObject",
			"storeGlobal",
		]);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("hoists invariants from a natural loop with multiple backedges", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 2 });
		const entry = builder.createBlock([{}, {}]);
		const exitCondition = builder.block(entry).parameters[0]!.value;
		const latchCondition = builder.block(entry).parameters[1]!.value;
		const header = builder.createBlock();
		const body = builder.createBlock();
		const leftLatch = builder.createBlock();
		const rightLatch = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: exitCondition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		const [constant] = builder.appendInstruction(body, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [sine] = builder.appendInstruction(body, "mathUnaryNumber", [constant!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [sine!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "branch",
			condition: latchCondition,
			consequent: { block: leftLatch, arguments: [] },
			alternate: { block: rightLatch, arguments: [] },
		});
		for (const latch of [leftLatch, rightLatch]) {
			builder.appendInstruction(latch, "storeGlobal", [latchCondition], {
				attributes: { index: 0 },
			});
			builder.setTerminator(latch, {
				kind: "jump",
				edge: { block: header, arguments: [] },
			});
		}
		builder.setTerminator(exit, { kind: "return", value: exitCondition });
		const original = builder.finish(entry);
		const originalLoop = buildCoreControlFlow(original, coreOpcodeRegistry).loops;
		expect(originalLoop).toHaveLength(1);
		expect(originalLoop[0]!.latches).toEqual(new Set([leftLatch, rightLatch]));

		const outcome = executeCoreOptimizations(
			{ ...coreProgram([original]), globalCount: 1 },
			{ verification: "per-pass" },
		);
		const fn = outcome.program.functions[0]!;
		const optimizedLoop = buildCoreControlFlow(fn, coreOpcodeRegistry).loops;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "loop-invariant-code-motion" && changed,
			),
		).toBe(true);
		expect(fn.blocks[entry]!.instructions.map(({ opcode }) => opcode)).toEqual([
			"createF64",
			"mathUnaryNumber",
		]);
		expect(optimizedLoop).toHaveLength(1);
		expect(optimizedLoop[0]).toMatchObject({ canonical: true });
		expect(optimizedLoop[0]!.preheader).toBeDefined();
		expect(optimizedLoop[0]!.latches.size).toBe(1);
		expect(optimizedLoop[0]!.exits.every(({ dedicated }) => dedicated)).toBe(true);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("hoists a contained array length read out of its canonical loop", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function sum() {
				const values = [1, 2, 3];
				let total = 0;
				for (let index = 0; index < values.length; index++) total += index;
				return total;
			}`,
			"core-loop-array-length.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});
		const fn = optimized!.functions[1]!;
		const loop = buildCoreControlFlow(fn, coreOpcodeRegistry).loops[0]!;
		const lengthLoads = fn.blocks.flatMap((block) =>
			block.instructions
				.filter(({ opcode, attributes }) => {
					if (opcode !== "loadPropertyStatic") return false;
					const index = attributes.stringIndex;
					return (
						typeof index === "number" &&
						String.fromCharCode(...optimized!.stringConstants[index]!) === "length"
					);
				})
				.map((instruction) => ({ block: block.id, instruction })),
		);
		expect(lengthLoads).toHaveLength(1);
		expect(lengthLoads[0]!.block).toBe(loop.preheader);
		expect(loop.blocks.has(lengthLoads[0]!.block)).toBe(false);
	});

	it("carries the loop range proof into guarded String bounds metadata", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function checksum(value) {
				let total = 0;
				for (let index = 0; index < value.length; index++) {
					total += value.charCodeAt(index);
				}
				return total;
			}`,
			"core-loop-string-bounds.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});
		const instructions = optimized!.functions[1]!.blocks.flatMap(
			({ instructions }) => instructions,
		);
		expect(
			instructions.some(
				({ opcode, attributes }) =>
					opcode === "call" && attributes.directStringCharCodeAtPosition === "inBounds",
			),
		).toBe(true);
		expect(
			instructions.some(
				({ opcode, attributes }) =>
					opcode === "loadPropertyStatic" && attributes.primitiveStringLength === true,
			),
		).toBe(true);
	});

	it("hoists only effect-qualified loads whose exact partition is invariant", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const [changing] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 0 },
			outputRepresentations: ["f64"],
		});
		const [stable] = builder.appendInstruction(header, "loadGlobal", [], {
			attributes: { index: 1 },
			outputRepresentations: ["f64"],
		});
		const [result] = builder.appendInstruction(
			header,
			"mathBinaryNumber",
			[changing!, stable!],
			{
				attributes: { operation: "Math.max" },
				outputRepresentations: ["f64"],
			},
		);
		builder.setTerminator(header, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.appendInstruction(body, "storeGlobal", [changing!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: result! });

		const outcome = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 2 },
			{ verification: "per-pass" },
		);
		const fn = outcome.program.functions[0]!;
		const loop = buildCoreControlFlow(fn, coreOpcodeRegistry).loops[0]!;
		const loadBlocks = new Map(
			fn.blocks.flatMap((block) =>
				block.instructions
					.filter(({ opcode }) => opcode === "loadGlobal")
					.map((instruction) => [instruction.attributes.index, block.id] as const),
			),
		);
		expect(loadBlocks.get(0)).toBe(loop.header);
		expect(loadBlocks.get(1)).toBe(loop.preheader);
	});

	it("forms a preheader and dedicated exit for a reducible shared-edge loop", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 3 });
		const entry = builder.createBlock([{}, {}, {}]);
		const [path, enter, iterate] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const header = builder.createBlock();
		const body = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: path!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.setTerminator(left, {
			kind: "branch",
			condition: enter!,
			consequent: { block: header, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: iterate!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: path! });
		const source = builder.finish(entry);
		const before = buildCoreControlFlow(source, coreOpcodeRegistry).loops[0]!;
		expect(before.preheader).toBeUndefined();
		expect(before.exits.some(({ dedicated }) => !dedicated)).toBe(true);

		const outcome = executeCoreOptimizations(coreProgram([source]), {
			verification: "per-pass",
		});
		const fn = outcome.program.functions[0]!;
		const loops = buildCoreControlFlow(fn, coreOpcodeRegistry).loops;
		expect(loops).toHaveLength(1);
		expect(loops[0]).toMatchObject({ canonical: true });
		expect(loops[0]!.preheader).toBeDefined();
		expect(loops[0]!.latches.size).toBe(1);
		expect(loops[0]!.exits.every(({ dedicated }) => dedicated)).toBe(true);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();

		const fixedPoint = executeCoreOptimizations(outcome.program, {
			verification: "per-pass",
		});
		expect(fixedPoint.changed).toBe(false);
		expect(fixedPoint.program).toEqual(outcome.program);
	});

	it("derives exact ranges only for safe additive block-argument inductions", () => {
		const build = (initial: number) => {
			const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
			const entry = builder.createBlock();
			const header = builder.createBlock([{ representation: "f64" }]);
			const body = builder.createBlock();
			const exit = builder.createBlock([{ representation: "f64" }]);
			const [seed] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: initial },
				outputRepresentations: ["f64"],
			});
			const [bound] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: 10 },
				outputRepresentations: ["f64"],
			});
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: header, arguments: [seed!] },
			});
			const counter = builder.block(header).parameters[0]!.value;
			const [condition] = builder.appendInstruction(header, "binary", [counter, bound!], {
				attributes: { operator: "<" },
				outputRepresentations: ["boolean"],
			});
			builder.setTerminator(header, {
				kind: "branch",
				condition: condition!,
				consequent: { block: body, arguments: [] },
				alternate: { block: exit, arguments: [counter] },
			});
			const [next] = builder.appendInstruction(body, "unary", [counter], {
				attributes: { operator: "increment" },
				outputRepresentations: ["f64"],
			});
			builder.setTerminator(body, {
				kind: "jump",
				edge: { block: header, arguments: [next!] },
			});
			builder.setTerminator(exit, {
				kind: "return",
				value: builder.block(exit).parameters[0]!.value,
			});
			return { fn: builder.finish(entry), counter };
		};
		const ascending = build(0);
		const analysis = new CoreAnalysisManager().loopInductions(ascending.fn);
		expect(analysis.induction(ascending.counter)).toMatchObject({
			step: 1,
			representation: "f64",
			comparison: { operator: "<" },
			range: {
				minimum: 0,
				maximum: 9,
				first: 0,
				last: 9,
				finalUpdate: 10,
				maximumIterations: 10,
				exactSafeIntegers: true,
				excludesNegativeZero: true,
			},
		});
		const negativeZero = build(-0);
		expect(
			new CoreAnalysisManager()
				.loopInductions(negativeZero.fn)
				.induction(negativeZero.counter)?.range,
		).toBeUndefined();
	});

	it("uses exact loop ranges for comparisons and remainder strength reduction", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const header = builder.createBlock([{ representation: "f64" }]);
		const body = builder.createBlock();
		const nonnegative = builder.createBlock();
		const impossible = builder.createBlock();
		const latch = builder.createBlock();
		const exit = builder.createBlock([{ representation: "f64" }]);
		const [zero] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		});
		const [bound] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 10 },
			outputRepresentations: ["f64"],
		});
		const [divisor] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 16 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [zero!] },
		});
		const index = builder.block(header).parameters[0]!.value;
		const [continues] = builder.appendInstruction(header, "binary", [index, bound!], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: continues!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [index] },
		});
		const [remainder] = builder.appendInstruction(body, "binary", [index, divisor!], {
			attributes: { operator: "%" },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(body, "storeGlobal", [remainder!], {
			attributes: { index: 0 },
		});
		const [rangeCheck] = builder.appendInstruction(body, "binary", [index, zero!], {
			attributes: { operator: ">=" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(body, {
			kind: "branch",
			condition: rangeCheck!,
			consequent: { block: nonnegative, arguments: [] },
			alternate: { block: impossible, arguments: [] },
		});
		builder.setTerminator(nonnegative, {
			kind: "jump",
			edge: { block: latch, arguments: [] },
		});
		builder.appendInstruction(impossible, "storeGlobal", [bound!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(impossible, {
			kind: "jump",
			edge: { block: latch, arguments: [] },
		});
		const [next] = builder.appendInstruction(latch, "unary", [index], {
			attributes: { operator: "increment" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(latch, {
			kind: "jump",
			edge: { block: header, arguments: [next!] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: builder.block(exit).parameters[0]!.value,
		});

		const outcome = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 1 },
			{ verification: "per-pass" },
		);
		const fn = outcome.program.functions[0]!;
		const binaries = fn.blocks.flatMap(({ instructions }) =>
			instructions.filter(({ opcode }) => opcode === "binary"),
		);
		expect(binaries).not.toContainEqual(
			expect.objectContaining({ attributes: { operator: "%" } }),
		);
		expect(binaries).not.toContainEqual(
			expect.objectContaining({ attributes: { operator: ">=" } }),
		);
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "optimize-loop-ranges" && changed,
			),
		).toBe(true);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("eliminates profitable partial redundancy without adding expressions or roots", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{ representation: "f64" }]);
		const condition = builder.block(entry).parameters[0]!.value;
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftOperand] = builder.appendInstruction(left, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		const [leftSine] = builder.appendInstruction(
			left,
			"mathUnaryNumber",
			[leftOperand!],
			{
				attributes: { operation: "Math.sin" },
				outputRepresentations: ["f64"],
			},
		);
		builder.appendInstruction(left, "storeGlobal", [leftSine!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftOperand!] },
		});
		const [rightOperand] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 0.25 },
			outputRepresentations: ["f64"],
		});
		builder.appendInstruction(right, "storeGlobal", [condition], {
			attributes: { index: 0 },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightOperand!] },
		});
		const operand = builder.block(join).parameters[0]!.value;
		const [result] = builder.appendInstruction(join, "mathUnaryNumber", [operand], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(join, { kind: "return", value: result! });

		const outcome = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 1 },
			{ verification: "per-pass" },
		);
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "partial-redundancy-elimination" && changed,
			),
		).toBe(true);
		expect(
			fn.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "mathUnaryNumber"),
			),
		).toHaveLength(2);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("removes a merge expression already available on every incoming path", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		const condition = builder.block(entry).parameters[0]!.value;
		const [operand] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		for (const branch of [left, right]) {
			const [sine] = builder.appendInstruction(branch, "mathUnaryNumber", [operand!], {
				attributes: { operation: "Math.sin" },
				outputRepresentations: ["f64"],
			});
			builder.appendInstruction(branch, "storeGlobal", [sine!], {
				attributes: { index: 0 },
			});
			builder.setTerminator(branch, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
		}
		const [result] = builder.appendInstruction(join, "mathUnaryNumber", [operand!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(join, { kind: "return", value: result! });

		const outcome = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 1 },
			{ maxRounds: 1, verification: "per-pass" },
		);
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "partial-redundancy-elimination" && changed,
			),
		).toBe(true);
		expect(
			fn.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "mathUnaryNumber"),
			),
		).toHaveLength(2);
		expect(() => verifyCoreFunction(fn, coreOpcodeRegistry)).not.toThrow();
	});

	it("does not resurrect a dead predecessor expression for PRE", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		const condition = builder.block(entry).parameters[0]!.value;
		const [operand] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 0.5 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.appendInstruction(left, "mathUnaryNumber", [operand!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(left, { kind: "jump", edge: { block: join, arguments: [] } });
		builder.appendInstruction(right, "storeGlobal", [condition], {
			attributes: { index: 0 },
		});
		builder.setTerminator(right, { kind: "jump", edge: { block: join, arguments: [] } });
		const [result] = builder.appendInstruction(join, "mathUnaryNumber", [operand!], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(join, { kind: "return", value: result! });

		const outcome = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), globalCount: 1 },
			{ maxRounds: 1, verification: "per-pass" },
		);
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "partial-redundancy-elimination" && changed,
			),
		).toBe(false);
		expect(
			fn.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "mathUnaryNumber"),
			),
		).toHaveLength(1);
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

	it("removes dead phi inputs and their pure producers in one liveness pass", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const [returned] = builder.appendInstruction(entry, "createUndefined", []);
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
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const [rightValue] = builder.appendInstruction(right, "createF64", [], {
			attributes: { value: 2 },
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
		const joined = builder.block(join).parameters[0]!.value;
		builder.appendInstruction(join, "mathUnaryNumber", [joined], {
			attributes: { operation: "Math.sin" },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(join, { kind: "return", value: returned! });

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			maxRounds: 1,
			verification: "per-pass",
		});
		const fn = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "dead-instruction-elimination" && changed,
			),
		).toBe(true);
		expect(fn.blocks.flatMap(({ instructions }) => instructions)).toEqual([
			expect.objectContaining({ opcode: "createUndefined", outputs: [returned] }),
		]);
		expect(fn.values.some(({ id }) => id === joined)).toBe(false);
		for (const block of fn.blocks) {
			for (const edge of coreTerminatorEdges(block.terminator)) {
				expect(edge.arguments).toEqual([]);
			}
		}
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
			fact: { kind: "unused-proof", value: true, claims: [], origin: "dce-test" },
		});
		builder.addFact({
			kind: "unused-summary",
			value: true,
			claims: [],
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

	it("preserves a dense-fill reserve when its exit is the next loop header", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function fillAndRead() {
				let total = 0;
				for (let outer = 0; outer < 8; outer++) {
					const values = [];
					for (let index = 0; index < 32; index++) values[index] = index;
					for (let index = 0; index < 32; index++) total += values[index];
				}
				return total;
			}`,
			"core-dense-fill-consecutive-loops.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const allocation = optimized!.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions }) => instructions)
			.find(({ opcode }) => opcode === "createArray");
		expect(allocation?.attributes.freshDenseReserveLength).toBe(32);
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

	it("keeps a claimed region's call operands out of constant embedding", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			'globalThis.result = Number("x42".slice(1));',
			"core-region-constant-receiver.js",
		);
		let optimized: CoreProgram | undefined;
		// Lowering rejects a region whose claimed call no longer names its receiver in
		// a register, so embedding the constant receiver would fail this compile.
		compileSemanticProgramToVmDefinition(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});
		expect(
			optimized!.functions.flatMap(({ regions }) => regions.map(({ kind }) => kind)),
		).toContain("string-slice-number");
		const claimed = new Set(
			lowerCoreProgramToTarget(optimized!).functions.flatMap(
				(fn) =>
					fn.regions?.flatMap(({ claimedInstructions }) => claimedInstructions) ?? [],
			),
		);
		expect(claimed.size).toBeGreaterThan(0);
		for (const instruction of claimed) {
			expect(instruction).not.toHaveProperty("immediateValues");
		}
	});

	it("does not inline a binding a nested closure can rebind", () => {
		const optimize = (setter: string) => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				`function outer(reassign) {
					function handler() { return 1; }
					function replacement() { return 2; }
					${setter}
					return handler();
				}`,
				"core-inline-nested-setter.js",
			);
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToVmDefinition(semantic, {
				afterCoreOptimization(program) {
					optimized = program;
				},
			});
			return optimized!.functions[1]!.blocks.flatMap(({ instructions }) => instructions);
		};
		const inlinedHandlerBody = (
			instructions: ReadonlyArray<CoreFunction["blocks"][number]["instructions"][number]>,
		) =>
			instructions.some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 1,
			);

		// `outer(true)` must call `replacement`. A function-local scan sees one store
		// into the captured cell and would inline `handler`'s body unguarded.
		const rebound = optimize(
			`const retarget = () => { handler = replacement; };
			if (reassign) retarget();`,
		);
		expect(rebound.some(({ opcode }) => opcode === "call")).toBe(true);
		expect(inlinedHandlerBody(rebound)).toBe(false);

		const closed = optimize("void replacement;");
		expect(closed.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(inlinedHandlerBody(closed)).toBe(true);
	});

	it("retains closed callee facts across bounded inline expansions", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer() {
				function leaf() { return 1; }
				function middle() { return leaf(); }
				return middle();
			}`,
			"core-inline-relocated-target.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});
		const outer = optimized!.functions[1]!;
		const instructions = outer.blocks.flatMap(({ instructions }) => instructions);
		expect(instructions.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			instructions.some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 1,
			),
		).toBe(true);
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
