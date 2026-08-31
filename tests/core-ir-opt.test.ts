import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
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
import {
	verifyCoreFunction,
	verifyCoreProgram,
} from "../src/compiler/core/core-ir-verifier.ts";
import { CORE_NO_EFFECTS, CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type { CoreFunction, CoreProgram } from "../src/compiler/core/core-ir.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { coreRegisterClasses } from "../src/compiler/target/lower-execution.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { coreCompilationForTest } from "./helpers/core-compilation.ts";

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

function optimizedClosedModule(source: string, sourcePath: string): CoreProgram {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		sourcePath,
		parseModule(source),
	);
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(semantic, {
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
	});
	expect(optimized).toBeDefined();
	return optimized!;
}

function functionIndexOfName(program: CoreProgram, name: string): number {
	const found = program.functions.find(
		(fn) =>
			String.fromCodePoint(
				...(program.stringConstants[fn.metadata.nameStringIndex] ?? []),
			) === name,
	);
	expect(found, `no Core function named ${name}`).toBeDefined();
	return found!.functionIndex;
}

describe("Core IR optimizer", () => {
	it("reuses canonical roots only while move and phi structure is unchanged", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 2,
		});
		const entry = builder.createBlock([{}, {}]);
		const [first, second] = builder.block(entry).parameters.map(({ value }) => value);
		const [moved] = builder.appendInstruction(entry, "move", [first!]);
		builder.setTerminator(entry, { kind: "return", value: moved! });
		const fn = builder.finish(entry);
		const analyses = new CoreAnalysisManager();
		const roots = analyses.canonicalValues(fn);
		const factsOnly = {
			...fn,
			facts: [...fn.facts],
			mutationEpoch: fn.mutationEpoch + 1,
		};
		analyses.inheritCanonicalValues(fn, factsOnly);
		expect(analyses.canonicalValues(factsOnly)).toBe(roots);

		const changedMove = {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) =>
					instruction.opcode === "move"
						? { ...instruction, inputs: [second!] }
						: instruction,
				),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
		analyses.inheritCanonicalValues(fn, changedMove);
		expect(analyses.canonicalValues(changedMove)).not.toBe(roots);
		expect(analyses.canonicalValues(changedMove).get(moved!)).toBe(second);
	});

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
		compileSemanticProgramToProgramImage(semantic, {
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
		compileSemanticProgramToProgramImage(semantic, {
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
		compileSemanticProgramToProgramImage(semantic, {
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

	it("uses primitive operator effects to forward memory across coercion sites", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		const [before] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftNumber] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [rightNumber] = builder.appendInstruction(right, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftNumber!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightNumber!] },
		});
		const number = builder.appendBlockParameter(join);
		const [one] = builder.appendInstruction(join, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.appendInstruction(join, "binary", [number, one!], {
			attributes: { operator: "+" },
		});
		const [after] = builder.appendInstruction(join, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [same] = builder.appendInstruction(join, "binary", [before!, after!], {
			attributes: { operator: "===" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(join, { kind: "return", value: same! });
		const program = { ...coreProgram([builder.finish(entry)]), globalCount: 1 };
		const baseline = executeCoreOptimizations(program, {
			ablations: new Set(["fact-driven"]),
			verification: "per-pass",
		}).program.functions[0]!;
		const optimized = executeCoreOptimizations(program, {
			verification: "per-pass",
		}).program.functions[0]!;

		expect(globalLoadCount(baseline)).toBe(2);
		expect(globalLoadCount(optimized)).toBe(1);
		expect(
			optimized.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(({ opcode }) => opcode === "binary"),
		).toHaveLength(1);
		expect(
			optimized.facts.some(({ kind }) => kind === "primitive-operator-effects"),
		).toBe(true);
	});

	it("retracts a primitive effect proof when a later pass rewrites the operator", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const parameter = builder.block(entry).parameters[0]!.value;
		const [type] = builder.appendInstruction(entry, "unary", [parameter], {
			attributes: { operator: "typeof" },
		});
		const [number] = builder.appendInstruction(entry, "createString", [], {
			attributes: { stringIndex: 1 },
		});
		const [matches] = builder.appendInstruction(entry, "binary", [type!, number!], {
			attributes: { operator: "===" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, { kind: "return", value: matches! });
		const program = {
			...coreProgram([builder.finish(entry)]),
			stringConstants: [[], [..."number"].map((unit) => unit.charCodeAt(0))],
		};
		const refined = executeCoreOptimizations(program, {
			ablations: new Set(["constant-folding"]),
			verification: "per-pass",
		}).program;
		const binary = refined.functions[0]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ opcode }) => opcode === "binary");
		expect(binary?.effectRefinement).toBeDefined();

		const folded = executeCoreOptimizations(refined, {
			verification: "per-pass",
		}).program;
		const comparison = folded.functions[0]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ opcode }) => opcode === "typeofCompare");
		expect(comparison?.effectRefinement).toBeUndefined();
		expect(() => verifyCoreProgram(folded, coreOpcodeRegistry)).not.toThrow();
	});

	it("keeps a primitive effect proof while operand kinds narrow", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const parameter = builder.block(entry).parameters[0]!.value;
		const [nullValue] = builder.appendInstruction(entry, "createNull", []);
		const [firstComparison] = builder.appendInstruction(
			entry,
			"binary",
			[parameter, nullValue!],
			{ attributes: { operator: "===" } },
		);
		const proof = builder.addFact({
			kind: "primitive-operator-effects",
			value: {
				operator: "===",
				masks: [COMPILER_VALUE_KIND_TOP, COMPILER_VALUE_KIND_TOP],
			},
			claims: [],
			validity: {
				kind: "summary",
				digest: `primitive-operator:===:${COMPILER_VALUE_KIND_TOP},${COMPILER_VALUE_KIND_TOP}`,
			},
			obligations: [],
			origin: "test-primitive-kinds",
		});
		const [secondComparison] = builder.appendInstruction(
			entry,
			"binary",
			[firstComparison!, parameter],
			{
				attributes: { operator: "===" },
				effectRefinement: { effects: CORE_NO_EFFECTS, proof },
			},
		);
		builder.setTerminator(entry, { kind: "return", value: secondComparison! });
		const input = builder.finish(entry);
		const secondInstruction = input.values.find(
			({ id }) => id === secondComparison,
		)!.definition;
		expect(secondInstruction.kind).toBe("instruction");

		const optimized = executeCoreOptimizations(coreProgram([input]), {
			verification: "per-pass",
		}).program;
		const refreshed = optimized.functions[0]!.facts.find(
			(fact) =>
				fact.kind === "primitive-operator-effects" &&
				secondInstruction.kind === "instruction" &&
				fact.claims.some(
					(claim) =>
						claim.kind === "effect" &&
						claim.instruction === secondInstruction.instruction,
				),
		);
		expect(refreshed?.value).toMatchObject({
			operator: "===",
			masks: [COMPILER_VALUE_KIND_BOOLEAN, COMPILER_VALUE_KIND_TOP],
		});
		expect(() => verifyCoreProgram(optimized, coreOpcodeRegistry)).not.toThrow();
	});

	it("removes coercion work already decided by primitive kinds", () => {
		const build = (functionIndex: number, coercible: boolean): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const condition = builder.block(entry).parameters[0]!.value;
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock();
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
			return builder.finish(entry);
		};
		const program = {
			...coreProgram([build(0, true), build(1, false)]),
			stringConstants: [[], []],
		};
		const baseline = executeCoreOptimizations(program, {
			ablations: new Set(["fact-driven"]),
			verification: "per-pass",
		}).program;
		const optimized = executeCoreOptimizations(program, {
			verification: "per-pass",
		}).program;
		const coercions = (fn: CoreFunction) =>
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(
					({ opcode }) => opcode === "requireCoercible" || opcode === "toPropertyKey",
				);

		expect(coercions(baseline.functions[0]!)).toHaveLength(2);
		expect(coercions(optimized.functions[0]!)).toHaveLength(0);
		expect(coercions(optimized.functions[1]!).map(({ opcode }) => opcode)).toEqual([
			"requireCoercible",
			"requireCoercible",
		]);
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
		const opcodes = fn.blocks.flatMap(({ instructions }) =>
			instructions.map(({ opcode }) => opcode),
		);
		expect(opcodes).not.toContain("loadPropertyStatic");
		// Once forwarding makes the object's identity dead, the allocation itself is
		// gone rather than merely becoming an unused non-discardable instruction.
		expect(opcodes).not.toContain("createObjectShaped");
	});

	it("removes a dead literal whose forwarded occupant may be weakly held", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const parameter = builder.block(entry).parameters[0]!.value;
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [parameter], {
			attributes: { keyStringIndices: [1] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const fn = executeCoreOptimizations(
			{ ...coreProgram([builder.finish(entry)]), stringConstants: [[], [102]] },
			{ verification: "per-pass" },
		).program.functions[0]!;
		const opcodes = fn.blocks.flatMap(({ instructions }) =>
			instructions.map(({ opcode }) => opcode),
		);
		expect(opcodes).not.toContain("loadPropertyStatic");
		expect(opcodes).not.toContain("createObjectShaped");
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: fn.parameters[0],
		});
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

	it("lowers chained sole explicit throws into their local handlers", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const innerHandler = builder.createBlock([{ role: "exception" }]);
		const outerHandler = builder.createBlock([{ role: "exception" }]);
		const thrown = builder.block(entry).parameters[0]!.value;
		builder.setHandler(entry, innerHandler);
		builder.setTerminator(entry, { kind: "throw", value: thrown });
		const rethrown = builder.block(innerHandler).parameters[0]!.value;
		builder.setHandler(innerHandler, outerHandler);
		builder.setTerminator(innerHandler, { kind: "throw", value: rethrown });
		builder.setTerminator(outerHandler, {
			kind: "return",
			value: builder.block(outerHandler).parameters[0]!.value,
		});

		const fn = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			verification: "per-pass",
		}).program.functions[0]!;
		expect(fn.blocks).toHaveLength(1);
		expect(fn.blocks[0]!.handler).toBeUndefined();
		expect(fn.blocks[0]!.terminator).toMatchObject({ kind: "return", value: thrown });
	});

	it("lowers shared explicit throws but keeps potentially throwing prefixes", () => {
		const shared = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = shared.createBlock([{}]);
		const left = shared.createBlock();
		const right = shared.createBlock();
		const handler = shared.createBlock([{ role: "exception" }]);
		const thrown = shared.block(entry).parameters[0]!.value;
		shared.setTerminator(entry, {
			kind: "branch",
			condition: thrown,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		for (const block of [left, right]) {
			shared.setHandler(block, handler);
			shared.setTerminator(block, { kind: "throw", value: thrown });
		}
		shared.setTerminator(handler, {
			kind: "return",
			value: shared.block(handler).parameters[0]!.value,
		});

		const throwing = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const throwingEntry = throwing.createBlock([{}]);
		const throwingHandler = throwing.createBlock([{ role: "exception" }]);
		const callee = throwing.block(throwingEntry).parameters[0]!.value;
		throwing.appendInstruction(throwingEntry, "call", [callee, callee]);
		throwing.setHandler(throwingEntry, throwingHandler);
		throwing.setTerminator(throwingEntry, { kind: "throw", value: callee });
		throwing.setTerminator(throwingHandler, {
			kind: "return",
			value: throwing.block(throwingHandler).parameters[0]!.value,
		});

		const [sharedResult, throwingResult] = executeCoreOptimizations(
			coreProgram([shared.finish(entry), throwing.finish(throwingEntry)]),
			{ verification: "per-pass" },
		).program.functions;
		expect(sharedResult!.blocks.every(({ handler: edge }) => edge === undefined)).toBe(
			true,
		);
		expect(
			sharedResult!.blocks.every(({ terminator }) => terminator.kind !== "throw"),
		).toBe(true);
		expect(throwingResult!.blocks[0]!.handler).toBeDefined();
	});

	it("lowers source try/catch around an explicit local throw", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function local(value) {
					try { throw value; }
					catch (error) { return error; }
				}
				globalThis.__localExceptionResult = local(42);`,
				"local-exception-flow.js",
			),
			{
				optimizationAblations: new Set(["inlining"]),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const local = optimized!.functions[functionIndexOfName(optimized!, "local")]!;
		expect(local.blocks.every(({ handler }) => handler === undefined)).toBe(true);
		expect(local.blocks.every(({ terminator }) => terminator.kind !== "throw")).toBe(
			true,
		);
	});

	it("keeps property accesses outside the private fresh-object prefix", () => {
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
		const expectedLoads = [
			{ ordinary: 2, guarded: 0 },
			{ ordinary: 0, guarded: 0 },
			{ ordinary: 0, guarded: 2 },
		];
		for (const [index, fn] of outcome.program.functions.entries()) {
			const fnInstructions = fn.blocks.flatMap(({ instructions }) => instructions);
			expect(
				fnInstructions.filter(({ opcode }) => opcode === "loadPropertyStatic"),
			).toHaveLength(expectedLoads[index]!.ordinary);
			expect(
				fnInstructions.filter(({ opcode }) => opcode === "loadPropertyStaticShapeCase"),
			).toHaveLength(expectedLoads[index]!.guarded);
		}
	});

	it("forwards a fresh own-slot load before a later escape", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const parameter = builder.block(entry).parameters[0]!.value;
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [parameter], {
			attributes: { keyStringIndices: [1] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.appendInstruction(entry, "storeGlobal", [object!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });

		const fn = executeCoreOptimizations(
			{
				...coreProgram([builder.finish(entry)]),
				stringConstants: [[], [102]],
				globalCount: 1,
			},
			{ verification: "per-pass" },
		).program.functions[0]!;
		const opcodes = fn.blocks
			.flatMap(({ instructions }) => instructions)
			.map(({ opcode }) => opcode);
		expect(opcodes).not.toContain("loadPropertyStatic");
		expect(opcodes).toContain("createObjectShaped");
		expect(opcodes).toContain("storeGlobal");
		expect(fn.blocks[0]!.terminator).toMatchObject({
			kind: "return",
			value: fn.parameters[0],
		});
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

	it("forwards an existing-slot write while a fresh object remains private", () => {
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
		).not.toContain("loadPropertyStatic");
		expect(fn.blocks[0]!.terminator).toMatchObject({ value: fn.parameters[1] });
	});

	it("scalarizes a contained slot through a branch join", () => {
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
		expect(count(1, "storePropertyStatic")).toBe(0);
		expect(count(1, "loadPropertyStatic")).toBe(0);
		expect(count(1, "createObjectShaped")).toBe(0);
		const scalarized = outcome.program.functions[1]!;
		const cfg = buildCoreControlFlow(scalarized, coreOpcodeRegistry);
		expect(
			scalarized.blocks.some(
				(block) =>
					block.parameters.length > 0 && cfg.predecessors[block.id]!.length === 2,
			),
		).toBe(true);
	});

	it("converges branch-join scalar replacement beyond the scheduler round limit", () => {
		const joinCount = 24;
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const [zero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		let current = entry;
		let returned = condition;
		for (let index = 0; index < joinCount; index++) {
			const [object] = builder.appendInstruction(current, "createObjectShaped", [zero!], {
				attributes: { keyStringIndices: [1] },
			});
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock();
			builder.setTerminator(current, {
				kind: "branch",
				condition,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			builder.appendInstruction(left, "storePropertyStatic", [object!, one!], {
				attributes: { stringIndex: 1 },
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			builder.appendInstruction(right, "storePropertyStatic", [object!, zero!], {
				attributes: { stringIndex: 1 },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			const [loaded] = builder.appendInstruction(join, "loadPropertyStatic", [object!], {
				attributes: { stringIndex: 1 },
			});
			builder.appendInstruction(join, "storeGlobal", [loaded!], {
				attributes: { index },
			});
			current = join;
			returned = loaded!;
		}
		builder.setTerminator(current, { kind: "return", value: returned });

		const outcome = executeCoreOptimizations(
			{
				...coreProgram([builder.finish(entry)]),
				stringConstants: [[], [102]],
				globalCount: joinCount,
			},
			{ verification: "per-pass" },
		);
		const propertyLoads = outcome.program.functions[0]!.blocks.flatMap(
			({ instructions }) =>
				instructions.filter(
					({ opcode }) => opcode === "loadProperty" || opcode === "loadPropertyStatic",
				),
		);
		expect(propertyLoads).toHaveLength(0);

		const fixedPoint = executeCoreOptimizations(outcome.program, {
			verification: "per-pass",
		});
		const withoutMutationEpoch = (program: CoreProgram): CoreProgram => ({
			...program,
			functions: program.functions.map((fn) => ({ ...fn, mutationEpoch: 0 })),
		});
		expect(withoutMutationEpoch(fixedPoint.program)).toEqual(
			withoutMutationEpoch(outcome.program),
		);
		expect(
			fixedPoint.program.functions[0]!.blocks.flatMap(({ instructions }) =>
				instructions.filter(
					({ opcode }) => opcode === "loadProperty" || opcode === "loadPropertyStatic",
				),
			),
		).toHaveLength(0);
	});

	it("keeps a branch-joined aggregate materialized after one arm publishes it", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
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
		builder.appendInstruction(left, "storeGlobal", [object!], {
			attributes: { index: 0 },
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
		const [loaded] = builder.appendInstruction(join, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(join, { kind: "return", value: loaded! });

		const fn = executeCoreOptimizations(
			{
				...coreProgram([builder.finish(entry)]),
				stringConstants: [[], [102]],
				globalCount: 1,
			},
			{ verification: "per-pass" },
		).program.functions[0]!;
		const opcodes = fn.blocks.flatMap(({ instructions }) =>
			instructions.map(({ opcode }) => opcode),
		);
		expect(opcodes).toContain("createObjectShaped");
		expect(opcodes).toContain("storeGlobal");
		expect(opcodes.some((opcode) => opcode.startsWith("loadProperty"))).toBe(true);
	});

	it("scalarizes a source object whose slot is selected by a branch", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function joined(flag) {
					const object = { value: 0 };
					if (flag) object.value = 41;
					else object.value = 42;
					return object.value;
				}
				globalThis.__joinedResult = joined(true) + joined(false);`,
				"scalar-branch-join.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const joined = optimized!.functions[functionIndexOfName(optimized!, "joined")]!;
		const opcodes = joined.blocks.flatMap(({ instructions }) =>
			instructions.map(({ opcode }) => opcode),
		);
		expect(opcodes).not.toContain("createObjectShaped");
		expect(opcodes).not.toContain("loadPropertyStatic");
		expect(opcodes).not.toContain("storePropertyStatic");
	});

	it("jointly erases an operand-rooted boxed object and its final store", () => {
		const compile = (ablateEscape: boolean): CoreFunction => {
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`function update(value) {
						const point = { x: value, y: value + 1 };
						point.x = point.x + point.y;
						return point.x;
					}
					globalThis.point = update(4);`,
					"scalar-operand-rooted-object.js",
				),
				{
					...(ablateEscape
						? { optimizationAblations: new Set(["escape"] as const) }
						: {}),
					afterCoreOptimization(program) {
						optimized = program;
					},
				},
			);
			return optimized!.functions[functionIndexOfName(optimized!, "update")]!;
		};
		const opcodes = (fn: CoreFunction) =>
			fn.blocks.flatMap(({ instructions }) => instructions.map(({ opcode }) => opcode));

		const optimizedOpcodes = opcodes(compile(false));
		expect(optimizedOpcodes).not.toContain("createObjectShaped");
		expect(optimizedOpcodes).not.toContain("storePropertyStatic");
		const ablatedOpcodes = opcodes(compile(true));
		expect(ablatedOpcodes).toContain("createObjectShaped");
		expect(ablatedOpcodes).toContain("storePropertyStatic");
	});

	it("roots a boxed virtual field across an intervening safepoint", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function preserve(value) {
					const object = { held: value };
					globalThis.observe();
					object.held = 0;
					return 1;
				}`,
				"scalar-unrooted-contained-field.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const preserve = optimized!.functions[functionIndexOfName(optimized!, "preserve")]!;
		const opcodes = preserve.blocks.flatMap(({ instructions }) =>
			instructions.map(({ opcode }) => opcode),
		);
		expect(opcodes).not.toContain("createObjectShaped");
		expect(opcodes).not.toContain("storePropertyStatic");
		expect(opcodes).toEqual(expect.arrayContaining(["call", "rootUse"]));
		const rootUse = preserve.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ opcode }) => opcode === "rootUse");
		expect(rootUse?.inputs).toHaveLength(1);
	});

	it("scalarizes a contained object through a must-alias move", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 2,
		});
		const entry = builder.createBlock([{}, {}]);
		const [value, observe] = builder.block(entry).parameters.map(({ value }) => value);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [value!], {
			attributes: { keyStringIndices: [1] },
		});
		const [alias] = builder.appendInstruction(entry, "move", [object!]);
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "call", [observe!, receiver!]);
		const [zero] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.appendInstruction(entry, "storePropertyStatic", [alias!, zero!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: zero! });

		const optimized = executeCoreOptimizations(
			{
				...coreProgram([builder.finish(entry)]),
				stringConstants: [[], [104, 101, 108, 100]],
			},
			{ maxRounds: 1 },
		).program.functions[0]!;
		const instructions = optimized.blocks.flatMap(({ instructions }) => instructions);
		const opcodes = instructions.map(({ opcode }) => opcode);
		expect(opcodes).not.toContain("createObjectShaped");
		expect(opcodes).not.toContain("move");
		expect(opcodes).not.toContain("storePropertyStatic");
		expect(opcodes).toContain("rootUse");
	});

	it("scalarizes a contained object through a must-alias block parameter", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 3,
		});
		const entry = builder.createBlock([{}, {}, {}]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{ representation: "boxed" }]);
		const [value, condition, observe] = builder
			.block(entry)
			.parameters.map(({ value }) => value);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [value!], {
			attributes: { keyStringIndices: [1] },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftAlias] = builder.appendInstruction(left, "move", [object!]);
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftAlias!] },
		});
		const [rightAlias] = builder.appendInstruction(right, "move", [object!]);
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightAlias!] },
		});
		const alias = builder.block(join).parameters[0]!.value;
		const [receiver] = builder.appendInstruction(join, "createUndefined", []);
		builder.appendInstruction(join, "call", [observe!, receiver!]);
		const [zero] = builder.appendInstruction(join, "createNumber", [], {
			attributes: { value: 0 },
		});
		builder.appendInstruction(join, "storePropertyStatic", [alias, zero!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(join, { kind: "return", value: zero! });

		const optimized = executeCoreOptimizations(
			{
				...coreProgram([builder.finish(entry)]),
				stringConstants: [[], [104, 101, 108, 100]],
			},
			{ maxRounds: 1, verification: "per-pass" },
		).program.functions[0]!;
		const opcodes = optimized.blocks.flatMap(({ instructions }) =>
			instructions.map(({ opcode }) => opcode),
		);
		expect(opcodes).not.toContain("createObjectShaped");
		expect(opcodes).not.toContain("storePropertyStatic");
		expect(opcodes).toEqual(expect.arrayContaining(["call", "rootUse"]));
	});

	it("dead-store elimination retains a slot whose values a WeakRef could observe", () => {
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
			{ verification: "per-pass", ablations: new Set(["escape"]) },
		);
		const stores = (functionIndex: number) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "storePropertyStatic"),
			).length;
		const allocations = (functionIndex: number) =>
			outcome.program.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "createObjectShaped"),
			).length;
		// The literal's initial value is an unproven reference, so dropping the store
		// that replaced it would keep that reference alive for longer.
		expect(stores(0)).toBe(1);
		expect(allocations(0)).toBe(1);
		// Every value the slot can hold is a number, so its reachability is not
		// observable; the store goes, then so does the now-dead allocation.
		expect(stores(1)).toBe(0);
		expect(allocations(1)).toBe(0);
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
		expect(binaries(5)).toHaveLength(1);
		expect(binaries(5)[0]).toMatchObject({ attributes: { operator: ">" } });
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
		expect(fn.values.find(({ id }) => id === joined)?.representation).toBe("i32");
		expect(
			fn.blocks
				.flatMap(({ instructions }) => instructions)
				.some(
					({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
				),
		).toBe(false);
		expect([...coreRegisterClasses(fn).registerRepresentations.values()]).toContain(
			"i32",
		);
	});

	it("materializes exact scalars carried through exception handlers", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function carry(callback) {
				let message = "base";
				try {
					if (callback()) message += "suffix";
					callback();
				} catch (error) {}
				return message;
			}`,
			"core-exception-scalar.js",
		);
		let optimized: CoreProgram | undefined;
		expect(() =>
			compileSemanticProgramToProgramImage(semantic, {
				afterCoreOptimization(program) {
					optimized = program;
				},
			}),
		).not.toThrow();
		const fn = optimized!.functions[functionIndexOfName(optimized!, "carry")]!;
		const handler = fn.blocks.find(
			({ parameters }) => parameters[0]?.role === "exception",
		)!;
		expect(
			handler.parameters
				.slice(1)
				.map(({ value }) => fn.values.find(({ id }) => id === value)!.representation),
		).toContain("string");
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
		compileSemanticProgramToProgramImage(semantic, {
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
		compileSemanticProgramToProgramImage(semantic, {
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
		const build = (initial: number, representation: "f64" | "i32" = "f64") => {
			const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
			const entry = builder.createBlock();
			const header = builder.createBlock([{ representation }]);
			const body = builder.createBlock();
			const exit = builder.createBlock([{ representation }]);
			const [seed] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: initial },
				outputRepresentations: [representation],
			});
			const [bound] = builder.appendInstruction(entry, "createF64", [], {
				attributes: { value: 10 },
				outputRepresentations: [representation],
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
				outputRepresentations: [representation],
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
		const int32 = build(0, "i32");
		expect(
			new CoreAnalysisManager().loopInductions(int32.fn).induction(int32.counter),
		).toMatchObject({
			representation: "i32",
			range: { minimum: 0, maximum: 9, finalUpdate: 10 },
		});
	});

	it("folds comparisons from reusable int32 ranges", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const condition = builder.block(entry).parameters[0]!.value;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{ representation: "i32" }]);
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
		const value = builder.block(join).parameters[0]!.value;
		const [limit] = builder.appendInstruction(join, "createF64", [], {
			attributes: { value: 0x8000_0000 },
			outputRepresentations: ["f64"],
		});
		const [comparison] = builder.appendInstruction(join, "binary", [value, limit!], {
			attributes: { operator: "<" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(join, { kind: "return", value: comparison! });
		const program = coreProgram([builder.finish(entry)]);
		const baseline = executeCoreOptimizations(program, {
			ablations: new Set(["fact-driven"]),
			verification: "per-pass",
		}).program.functions[0]!;
		const optimized = executeCoreOptimizations(program, {
			verification: "per-pass",
		}).program.functions[0]!;
		const opcodes = (fn: CoreFunction) =>
			fn.blocks.flatMap(({ instructions }) => instructions).map(({ opcode }) => opcode);

		expect(opcodes(baseline)).toContain("binary");
		expect(opcodes(optimized)).not.toContain("binary");
		expect(
			optimized.blocks
				.flatMap(({ instructions }) => instructions)
				.find(({ opcode }) => opcode === "createBoolean")?.attributes.value,
		).toBe(true);
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
		compileSemanticProgramToProgramImage(semantic, {
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
		compileSemanticProgramToProgramImage(semantic, {
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

	it("publishes contained collection calls before fact-driven cleanup", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(value) {
				const map = new Map();
				map.set("value", value);
				return map.get("value");
			}
			globalThis.result = read(globalThis.value);`,
			"core-early-exact-heap.js",
		);
		let optimized: CoreProgram | undefined;
		let optimizedContext: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			optimizationAblations: new Set(["inlining"]),
			profile: true,
			afterCoreOptimization(program, context) {
				optimized = program;
				optimizedContext = context;
			},
		});

		expect(optimizedContext!.optimizationTrace).toContainEqual(
			expect.objectContaining({
				pass: "publish-exact-heap-consequences",
				changed: true,
			}),
		);
		const collectionCalls = optimized!.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions }) => instructions)
			.filter(({ opcode }) => opcode === "callBuiltin");
		const set = collectionCalls.find(
			({ attributes }) => attributes.operation === "Map.prototype.set",
		)!;
		const get = collectionCalls.find(
			({ attributes }) => attributes.operation === "Map.prototype.get",
		)!;
		expect(set.effectRefinement?.effects).toMatchObject({
			mayGc: true,
			mayThrow: false,
			callsUserCode: false,
		});
		expect(get.effectRefinement?.effects).toMatchObject({
			mayGc: false,
			mayThrow: false,
			callsUserCode: false,
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
		compileSemanticProgramToProgramImage(semantic, {
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
		compileSemanticProgramToProgramImage(semantic, {
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

	it("converges exact fresh-array builtin selection through CFG cleanup", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function pushPop(value) {
				const values = [];
				try {
					values.push(value);
					return values.pop();
				} catch (error) {
					return 0;
				}
			}
			globalThis.result = pushPop(globalThis.value);`,
			"core-exact-array-cleanup.js",
		);
		let optimized: CoreProgram | undefined;
		let optimizedContext: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			profile: true,
			afterCoreOptimization(program, context) {
				optimized = program;
				optimizedContext = context;
			},
		});

		const pushPop = optimized!.functions[functionIndexOfName(optimized!, "pushPop")]!;
		expect(
			pushPop.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(({ opcode }) => opcode === "callBuiltin")
				.map(({ attributes }) => attributes.operation),
		).toEqual(["Array.prototype.push", "Array.prototype.pop"]);
		expect(
			pushPop.blocks
				.filter(({ handler }) => handler !== undefined)
				.every(({ instructions }) => instructions.length > 0),
		).toBe(true);

		const trace = optimizedContext!.optimizationTrace!;
		const rewrites = trace.filter(
			({ pass }) => pass === "rewrite-contained-fresh-array-builtins",
		);
		expect(rewrites.map(({ changed }) => changed)).toEqual([true, false]);
		const firstRewrite = trace.indexOf(rewrites[0]!);
		const pruned = trace.findIndex(
			(entry, index) =>
				index > firstRewrite &&
				entry.pass === "prune-vacuous-exception-handlers" &&
				entry.changed,
		);
		const folded = trace.findIndex(
			(entry, index) =>
				index > pruned && entry.pass === "fold-empty-forwarding-blocks" && entry.changed,
		);
		expect(pruned).toBeGreaterThan(firstRewrite);
		expect(folded).toBeGreaterThan(pruned);
		expect(trace.indexOf(rewrites[1]!)).toBeGreaterThan(folded);

		const rerun = executeCoreOptimizations(optimized!, { context: optimizedContext });
		const withoutMutationEpoch = (program: CoreProgram): CoreProgram => ({
			...program,
			functions: program.functions.map((fn) => ({ ...fn, mutationEpoch: 0 })),
		});
		expect(withoutMutationEpoch(rerun.program)).toEqual(withoutMutationEpoch(optimized!));
		expect(
			rerun.context!.optimizationTrace!.filter(
				({ pass }) => pass === "rewrite-contained-fresh-array-builtins",
			),
		).toEqual([expect.objectContaining({ changed: false })]);
		expect(
			rerun.context!.optimizationTrace!.some(
				({ pass }) => pass === "prune-vacuous-exception-handlers",
			),
		).toBe(false);
	});

	it("keeps exact Date clock reads distinct and forwards only consumed arguments", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function dates(value, extra) {
				const first = Date.now(extra());
				const second = Date.now(extra());
				const parsed = Date.parse(value, extra());
				const utc = Date.UTC(2001, 1, 3, 4, 5, 6, 7, extra());
				return first + second + parsed + utc;
			}`,
			"core-exact-date-builtins.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const calls = optimized!.functions[1]!.blocks.flatMap(
			({ instructions }) => instructions,
		).filter(({ opcode }) => opcode === "callBuiltin");
		expect(calls.map(({ attributes }) => attributes.operation)).toEqual([
			"Date.now",
			"Date.now",
			"Date.parse",
			"Date.UTC",
		]);
		// input 0 is the intrinsic receiver; discarded extra arguments were already
		// evaluated in preceding IR and do not cross the direct builtin ABI.
		expect(calls.map(({ inputs }) => inputs.length)).toEqual([1, 1, 2, 8]);
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
		let optimizedContext: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			profile: true,
			afterCoreOptimization(program, context) {
				optimized = program;
				optimizedContext = context;
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
		expect(optimizedContext!.optimizationDecisions).toContainEqual(
			expect.objectContaining({
				functionIndex: 1,
				code: "optimization.applied.inline",
				outcome: "applied",
			}),
		);
	});

	it("guards an open singleton inline and joins the generic fallback result", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer(value) {
				let handler = (input) => input + 10;
				function install(other) { handler = other; }
				globalThis.install = install;
				try { return handler(value) * 2; }
				catch (error) { return error; }
			}`,
			"core-guarded-inline.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const outer = optimized!.functions[functionIndexOfName(optimized!, "outer")]!;
		const handlerIndex = functionIndexOfName(optimized!, "handler");
		const guardBlock = outer.blocks.find((block) =>
			block.instructions.some(({ opcode }) => opcode === "guardFunctionIndex"),
		);
		expect(guardBlock?.terminator.kind).toBe("branch");
		if (guardBlock?.terminator.kind !== "branch") return;
		const fast = outer.blocks[guardBlock.terminator.consequent.block]!;
		const fallback = outer.blocks[guardBlock.terminator.alternate.block]!;
		const guard = guardBlock.instructions.find(
			({ opcode }) => opcode === "guardFunctionIndex",
		);
		const fallbackCalls = fallback.instructions.filter(({ opcode }) => opcode === "call");
		expect(fallbackCalls).toHaveLength(1);
		expect(fallbackCalls[0]!.attributes.directFunctionIndex).toBeUndefined();
		expect(fallbackCalls[0]!.attributes.calleeTargets).toMatchObject({
			functions: [handlerIndex],
			anyScript: false,
			opaque: true,
		});
		expect(guard?.inputs).toEqual([fallbackCalls[0]!.inputs[0]]);
		expect(guard?.attributes.functionIndex).toBe(handlerIndex);
		const inlinedBody = fast.instructions.find(
			({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
		);
		expect(inlinedBody).toBeDefined();
		const handlerBody = optimized!.functions[handlerIndex]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ opcode }) => opcode === "binary");
		expect(inlinedBody?.attributes).toEqual(handlerBody?.attributes);
		expect(
			fast.instructions.some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 10,
			),
		).toBe(true);
		expect(fast.terminator.kind).toBe("jump");
		expect(fallback.terminator.kind).toBe("jump");
		if (fast.terminator.kind !== "jump" || fallback.terminator.kind !== "jump") return;
		expect(fast.terminator.edge.block).toBe(fallback.terminator.edge.block);
		const join = outer.blocks[fast.terminator.edge.block]!;
		expect(join.parameters).toHaveLength(1);
		expect(fast.terminator.edge.arguments).toHaveLength(1);
		expect(fallback.terminator.edge.arguments).toHaveLength(1);
		// The inlined binary, generic call, and post-call multiplication all retain
		// the source try/catch edge after the original block is split. The frontend
		// may already have put the multiplication in the join's successor.
		expect(fast.handler?.block).toBe(fallback.handler?.block);
		expect(fallback.handler).toBeDefined();
		const postCall = outer.blocks.find((block) =>
			block.instructions.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "*",
			),
		);
		expect(postCall?.handler?.block).toBe(fallback.handler?.block);

		const rerun = executeCoreOptimizations(optimized!).program;
		const rerunOuter = rerun.functions[functionIndexOfName(rerun, "outer")]!;
		const rerunInstructions = rerunOuter.blocks.flatMap(
			({ instructions }) => instructions,
		);
		expect(
			rerunInstructions.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(1);
		const rerunCalls = rerunInstructions.filter(({ opcode }) => opcode === "call");
		expect(rerunCalls).toHaveLength(1);
		expect(rerunCalls[0]!.attributes.directFunctionIndex).toBeUndefined();
		expect(rerunCalls[0]!.attributes.calleeTargets).toMatchObject({
			functions: [handlerIndex],
			anyScript: false,
			opaque: true,
		});
	});

	it("dispatches a residual finite target set through guarded direct calls", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function caller(useSecond, value) {
				function first(input) {
					if (input > 0) return input + 1;
					return input - 1;
				}
				function second(input) {
					if (input > 0) return input + 2;
					return input - 2;
				}
				const handler = useSecond ? second : first;
				let total = 0;
				for (let index = 0; index < 3; index++) total += handler(value + index);
				return total * 2;
			}
			globalThis.result = caller(globalThis.useSecond, globalThis.value);`,
			"core-finite-dispatch.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const caller = optimized!.functions[functionIndexOfName(optimized!, "caller")]!;
		const instructions = caller.blocks.flatMap(({ instructions }) => instructions);
		const guards = instructions.filter(({ opcode }) => opcode === "guardFunctionIndex");
		const calls = instructions.filter(({ opcode }) => opcode === "call");
		const direct = calls.filter(
			({ attributes }) => typeof attributes.finiteDispatchTarget === "number",
		);
		const fallback = calls.filter(
			({ attributes }) => attributes.finiteDispatchTarget === undefined,
		);
		const targetIndices = [
			functionIndexOfName(optimized!, "first"),
			functionIndexOfName(optimized!, "second"),
		].sort((left, right) => left - right);
		expect(guards).toHaveLength(2);
		expect(
			guards
				.map(({ attributes }) => attributes.functionIndex)
				.sort((left, right) => Number(left) - Number(right)),
		).toEqual(targetIndices);
		expect(direct).toHaveLength(2);
		expect(
			direct
				.map(({ attributes }) => attributes.directFunctionIndex)
				.sort((left, right) => Number(left) - Number(right)),
		).toEqual(targetIndices);
		expect(fallback).toHaveLength(1);
		expect(fallback[0]!.attributes.directFunctionIndex).toBeUndefined();
		expect(fallback[0]!.attributes.calleeTargets).toMatchObject({
			functions: targetIndices,
			anyScript: false,
			opaque: false,
		});

		const rerun = executeCoreOptimizations(optimized!).program;
		const rerunCaller = rerun.functions[functionIndexOfName(rerun, "caller")]!;
		expect(
			rerunCaller.blocks
				.flatMap(({ instructions }) => instructions)
				.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(2);

		const forged: CoreProgram = {
			...optimized!,
			functions: optimized!.functions.map((fn) =>
				fn !== caller
					? fn
					: {
							...fn,
							blocks: fn.blocks.map((block) => ({
								...block,
								instructions: block.instructions.map((instruction) =>
									instruction === guards[0]
										? {
												...instruction,
												attributes: {
													...instruction.attributes,
													functionIndex: targetIndices[1]!,
												},
											}
										: instruction,
								),
							})),
						},
			),
		};
		expect(() => verifyCoreProgram(forged, coreOpcodeRegistry)).toThrow(
			"is not protected by its function-index guard",
		);
	});

	it("guards and inlines a class static method candidate", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`class Service { static run(value) { return value + 10; } }
			function caller(value) { return Service.run(value) * 2; }
			caller(1);`,
			"core-guarded-static-inline.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const caller = optimized!.functions[functionIndexOfName(optimized!, "caller")]!;
		const target = functionIndexOfName(optimized!, "run");
		const instructions = caller.blocks.flatMap(({ instructions }) => instructions);
		const guards = instructions.filter(({ opcode }) => opcode === "guardFunctionIndex");
		const calls = instructions.filter(({ opcode }) => opcode === "call");
		expect(guards).toHaveLength(1);
		expect(guards[0]!.attributes.functionIndex).toBe(target);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.attributes.directFunctionIndex).toBeUndefined();
		expect(calls[0]!.attributes.calleeTargets).toMatchObject({
			functions: [target],
			anyScript: false,
			opaque: true,
		});
		expect(
			instructions.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			),
		).toBe(true);
	});

	it("never inlines class constructors through ordinary calls", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function callClosed(value) {
				class Closed { constructor(input) { return input + 1; } }
				return Closed(value);
			}
			function callOpen(value) {
				let Current = class Open { constructor(input) { return input + 2; } };
				function install(other) { Current = other; }
				globalThis.installClass = install;
				return Current(value);
			}
			callClosed(1);
			callOpen(1);`,
			"core-class-constructor-inline.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		for (const [name, targetName, direct] of [
			["callClosed", "Closed", true],
			["callOpen", "Open", false],
		] as const) {
			const caller = optimized!.functions[functionIndexOfName(optimized!, name)]!;
			const instructions = caller.blocks.flatMap(({ instructions }) => instructions);
			const calls = instructions.filter(({ opcode }) => opcode === "call");
			expect(calls).toHaveLength(1);
			expect(calls[0]!.attributes.directFunctionIndex).toBe(
				direct ? functionIndexOfName(optimized!, targetName) : undefined,
			);
			expect(instructions.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(
				false,
			);
		}
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
		let optimizedContext: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			profile: true,
			afterCoreOptimization(program, context) {
				optimized = program;
				optimizedContext = context;
			},
		});

		const outer = optimized!.functions[1]!;
		expect(
			outer.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "call"),
		).toBe(true);
		expect(optimizedContext!.optimizationDecisions).toContainEqual(
			expect.objectContaining({
				functionIndex: 1,
				code: "optimization.declined.inner-closure",
				outcome: "declined",
				reason: "inner-closure",
			}),
		);
	});

	it("does not inline a closure body against the caller environment", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer(input) {
				function closure() { return input + 1; }
				return closure();
			}
			outer(13);`,
			"core-inline-callee-environment.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const outer = optimized!.functions[functionIndexOfName(optimized!, "outer")]!;
		const closure = optimized!.functions[functionIndexOfName(optimized!, "closure")]!;
		const calls = outer.blocks
			.flatMap(({ instructions }) => instructions)
			.filter(({ opcode }) => opcode === "call");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.attributes.directFunctionIndex).toBe(closure.functionIndex);
		expect(
			closure.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "loadCaptured"),
		).toBe(true);
	});

	it("keeps a claimed region's call operands out of constant embedding", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			'globalThis.result = Number("x42".slice(1));',
			"core-region-constant-receiver.js",
		);
		let optimized: CoreProgram | undefined;
		// Lowering rejects a region whose claimed call no longer names its receiver in
		// a register, so embedding the constant receiver would fail this compile.
		compileSemanticProgramToProgramImage(semantic, {
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});
		expect(
			optimized!.functions.flatMap(({ regions }) => regions.map(({ kind }) => kind)),
		).toContain("string-slice-number");
		const claimed = new Set(
			lowerCoreCompilationToExecution(
				coreCompilationForTest(optimized!),
			).functions.flatMap(
				(fn) =>
					fn.specializations?.flatMap(({ claimedInstructions }) => claimedInstructions) ??
					[],
			),
		);
		expect(claimed.size).toBeGreaterThan(0);
		for (const instruction of claimed) {
			expect(instruction).not.toHaveProperty("immediateValues");
		}
	});

	it("guards every finite target a nested closure can install", () => {
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
			compileSemanticProgramToProgramImage(semantic, {
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
		// into the captured cell and would inline `handler`'s body unguarded; the
		// bounded whole-program set instead emits one guard per possible target and
		// retains the generic call as the semantic twin.
		const rebound = optimize(
			`const retarget = () => { handler = replacement; };
			if (reassign) retarget();`,
		);
		expect(rebound.some(({ opcode }) => opcode === "call")).toBe(true);
		expect(rebound.filter(({ opcode }) => opcode === "guardFunctionIndex")).toHaveLength(
			2,
		);
		expect(inlinedHandlerBody(rebound)).toBe(true);
		expect(
			rebound.some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 2,
			),
		).toBe(true);

		const closed = optimize("void replacement;");
		expect(closed.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(inlinedHandlerBody(closed)).toBe(true);
	});

	it("keeps an over-budget finite target set on the generic path", () => {
		const target = (functionIndex: number): CoreFunction => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			let value = builder.block(entry).parameters[0]!.value;
			// Each body is independently small enough to inline, but their combined
			// clone-and-guard cost exceeds the finite-chain budget.
			for (let index = 0; index < 12; index++) {
				const [constant] = builder.appendInstruction(entry, "createNumber", [], {
					attributes: { value: index + 1 },
				});
				const [next] = builder.appendInstruction(entry, "binary", [value, constant!], {
					attributes: { operator: "+" },
				});
				value = next!;
			}
			builder.setTerminator(entry, { kind: "return", value });
			return builder.finish(entry);
		};
		const caller = new CoreFunctionBuilder(2, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = caller.createBlock([{}]);
		const firstBlock = caller.createBlock();
		const secondBlock = caller.createBlock();
		const join = caller.createBlock([{}]);
		const [first] = caller.appendInstruction(firstBlock, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		const [second] = caller.appendInstruction(secondBlock, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		caller.setTerminator(entry, {
			kind: "branch",
			condition: caller.block(entry).parameters[0]!.value,
			consequent: { block: firstBlock, arguments: [] },
			alternate: { block: secondBlock, arguments: [] },
		});
		caller.setTerminator(firstBlock, {
			kind: "jump",
			edge: { block: join, arguments: [first!] },
		});
		caller.setTerminator(secondBlock, {
			kind: "jump",
			edge: { block: join, arguments: [second!] },
		});
		const callee = caller.block(join).parameters[0]!.value;
		const [thisValue] = caller.appendInstruction(join, "createUndefined", []);
		const [argument] = caller.appendInstruction(join, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [result] = caller.appendInstruction(join, "call", [
			callee,
			thisValue!,
			argument!,
		]);
		caller.setTerminator(join, { kind: "return", value: result! });

		const optimized = executeCoreOptimizations(
			coreProgram([target(0), target(1), caller.finish(entry)]),
			{ verification: "per-pass" },
		).program.functions[2]!;
		const instructions = optimized.blocks.flatMap(({ instructions }) => instructions);
		expect(instructions.filter(({ opcode }) => opcode === "call")).toHaveLength(1);
		expect(
			instructions.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(0);
	});

	it("retains closed callee facts across bounded inline expansions", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer() {
				function leaf() { return 1; }
				function middle(target) { return target(); }
				return middle(leaf);
			}`,
			"core-inline-relocated-target.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
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

	it("spends the inline budget on body cost rather than call count", () => {
		const nested = Array.from({ length: 16 }, () => "leaf(").join("");
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function outer(value) {
				function leaf(input) { return input + 1; }
				return ${nested}value${")".repeat(16)};
			}
			outer(1);`,
			"core-inline-tiny-chain.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const outer = optimized!.functions[functionIndexOfName(optimized!, "outer")]!;
		expect(
			outer.blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "call"),
		).toBe(false);
	});

	it("keeps an exact allocation-helper chain within the generated code budget", () => {
		const sourcePath = "core-inline-allocation-chain.js";
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`const vector = (x, y, z) => ({ x, y, z });
			const scale = (value, factor) =>
				vector(value.x * factor, value.y * factor, value.z * factor);
			const add = (left, right) =>
				vector(left.x + right.x, left.y + right.y, left.z + right.z);
			const dot = (left, right) =>
				left.x * right.x + left.y * right.y + left.z * right.z;
			function hot(limit) {
				let checksum = 0;
				for (let index = 0; index < limit; index++) {
					const first = vector(index, index + 1, index + 2);
					const second = scale(first, 0.5);
					const result = add(first, second);
					checksum += dot(result, second);
				}
				return checksum;
			}
			hot(10);`,
			sourcePath,
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(resolveBuildConfig({})),
				programClosureCertificate(
					{ kind: "whole-program", entry: sourcePath },
					[{ kind: "entry-module", module: sourcePath }],
					[],
				),
			),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const hot = optimized!.functions[functionIndexOfName(optimized!, "hot")]!;
		const instructions = hot.blocks.flatMap(({ instructions }) => instructions);
		expect(instructions.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			instructions.some(
				({ opcode }) => opcode === "createObject" || opcode === "createObjectShaped",
			),
		).toBe(false);
	});

	it("admits benchmark-sized guarded helpers by emitted statement cost", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`const vector = (x, y, z) => ({ x, y, z });
			const scale = (value, factor) =>
				vector(value.x * factor, value.y * factor, value.z * factor);
			const add = (left, right) =>
				vector(left.x + right.x, left.y + right.y, left.z + right.z);
			const dot = (left, right) =>
				left.x * right.x + left.y * right.y + left.z * right.z;
			function hot(limit) {
				let checksum = 0;
				for (let index = 0; index < limit; index++) {
					const first = vector(index, index + 1, index + 2);
					const second = scale(first, 0.5);
					const result = add(first, second);
					checksum += dot(result, second);
				}
				return checksum;
			}
			hot(10);`,
			"core-guarded-inline-allocation-chain.js",
		);
		let optimized: CoreProgram | undefined;
		let optimizedContext: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			profile: true,
			afterCoreOptimization(program, context) {
				optimized = program;
				optimizedContext = context;
			},
		});

		const hotIndex = functionIndexOfName(optimized!, "hot");
		const instructions = optimized!.functions[hotIndex]!.blocks.flatMap(
			({ instructions }) => instructions,
		);
		expect(
			instructions.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(6);
		expect(
			instructions.some(
				({ attributes }) => typeof attributes.finiteDispatchTarget === "number",
			),
		).toBe(false);
		expect(
			optimizedContext!.optimizationDecisions?.filter(
				({ functionIndex, code }) =>
					functionIndex === hotIndex && code === "optimization.applied.inline",
			),
		).toHaveLength(4);
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
		compileSemanticProgramToProgramImage(semantic, {
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
		const definition = compileSemanticProgramToProgramImage(semantic, {
			profile: true,
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		expect(optimized!.functions[1]!.regions).toContainEqual(
			expect.objectContaining({ kind: "stack-object-plan" }),
		);
		expect(definition.native.functions[1]!.specializations).toContainEqual(
			expect.objectContaining({
				kind: "stack-object-plan",
				sites: [expect.objectContaining({ materializations: [expect.any(Object)] })],
			}),
		);
		expect(definition.diagnostics.profileRemarks).toContainEqual(
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
		compileSemanticProgramToProgramImage(semantic, {
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
		const definition = compileSemanticProgramToProgramImage(semantic, {
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
		const vmRegion = definition.native.functions[1]!.specializations.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(vmRegion?.license.materialization).toBe("on-demand");
		if (vmRegion?.kind !== "stack-object-plan") throw new Error("expected stack region");
		expect(typeof vmRegion.sites[0]!.inheritedAccessIp).toBe("number");
	});

	it("scalarizes a fully local object across branch stores", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function read(value, replace) {
				const object = { value };
				if (replace) object.value = 1;
				else object.value = 2;
				return object.value;
			}`,
			"core-local-stack-object.js",
		);
		let optimized: CoreProgram | undefined;
		const definition = compileSemanticProgramToProgramImage(semantic, {
			afterCoreOptimization(program) {
				optimized = program;
			},
		});

		const fn = optimized!.functions[1]!;
		const opcodes = fn.blocks.flatMap(({ instructions }) =>
			instructions.map(({ opcode }) => opcode),
		);
		expect(opcodes).not.toContain("createObjectShaped");
		expect(opcodes).not.toContain("loadPropertyStatic");
		expect(opcodes).not.toContain("storePropertyStatic");
		expect(fn.regions.some(({ kind }) => kind === "stack-object-plan")).toBe(false);

		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(definition));
		expect(
			restored.native.functions[1]!.specializations.some(
				({ kind }) => kind === "stack-object-plan",
			),
		).toBe(false);
	});

	it("joins closed stack-cell contents before refining property-load representations", () => {
		const compile = (body: string, sourcePath: string) => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				`function read(flag, count) { ${body} }`,
				sourcePath,
			);
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToProgramImage(semantic, {
				afterCoreOptimization(program) {
					optimized = program;
				},
			});
			return optimized!.functions[1]!;
		};
		const propertyLoadRepresentations = (fn: CoreFunction) => {
			const representations = new Map(
				fn.values.map(({ id, representation }) => [id, representation] as const),
			);
			return fn.blocks.flatMap(({ instructions }) =>
				instructions.flatMap((instruction) =>
					instruction.opcode === "loadPropertyStatic"
						? [representations.get(instruction.outputs[0]!)]
						: [],
				),
			);
		};

		const homogeneous = compile(
			`const object = { value: true };
			for (let i = 0; i < count; i++) {
				if (flag) object.value = true;
				else object.value = false;
			}
			return object.value;`,
			"core-stack-cell-boolean.js",
		);
		expect(propertyLoadRepresentations(homogeneous)).toEqual(["boolean"]);
		expect(homogeneous.regions).toContainEqual(
			expect.objectContaining({ kind: "stack-object-plan" }),
		);

		const mixed = compile(
			`const object = { value: true };
			for (let i = 0; i < count; i++) {
				if (flag) object.value = false;
				else object.value = 1;
			}
			return object.value;`,
			"core-stack-cell-mixed.js",
		);
		expect(propertyLoadRepresentations(mixed)).toEqual(["boxed"]);

		const integer = compile(
			`const object = { value: 1 };
			const alias = object;
			if (flag) alias.value = 9;
			return object.value;`,
			"core-stack-cell-integer.js",
		);
		expect(propertyLoadRepresentations(integer)).toEqual(["i32"]);

		const escaping = compile(
			`const object = { value: true };
			if (flag) object.value = false;
			return object;`,
			"core-stack-cell-materialized.js",
		);
		const escapeRegion = escaping.regions.find(
			({ kind }) => kind === "stack-object-plan",
		);
		expect(escapeRegion?.data).toMatchObject({
			license: { materialization: "on-demand" },
		});
	});

	it("preserves every selected region beyond the former fixed VM ceiling", () => {
		const declarations = Array.from(
			{ length: 41 },
			(_, index) =>
				`const object${index} = { value: values[${index}] };
				if (values[${index}]) object${index}.value = values[${index}] + 1;
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
		const definition = compileSemanticProgramToProgramImage(semantic);
		const regions = definition.native.functions[1]!.specializations;

		expect(regions.length).toBeGreaterThan(40);
		expect(regions.filter(({ kind }) => kind === "stack-object-plan")).toHaveLength(41);
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(definition)).native
				.functions[1]!.specializations,
		).toEqual(regions);
	});

	it("certifies only closed String.split projections", () => {
		const compile = (body: string): CoreProgram => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				`function project(value) { ${body} }`,
				"core-string-split.js",
			);
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToProgramImage(semantic, {
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
		compileSemanticProgramToProgramImage(semantic, {
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

	it("folds whole-program primitive observations before final lowering", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`function observe(condition) {
				const text = condition ? "value" : "other";
				const absent = condition ? null : undefined;
				return typeof text === "string" && text !== 1 && !absent;
			}
			globalThis.result = observe(globalThis.condition);`,
			"core-whole-program-kinds.js",
		);
		const compile = (ablate: boolean): CoreProgram => {
			let optimized: CoreProgram | undefined;
			compileSemanticProgramToProgramImage(semantic, {
				...(ablate ? { optimizationAblations: new Set(["fact-driven"] as const) } : {}),
				afterCoreOptimization(program) {
					optimized = program;
				},
			});
			return optimized!;
		};
		const observations = (program: CoreProgram) =>
			program.functions[functionIndexOfName(program, "observe")]!.blocks.flatMap(
				({ instructions }) => instructions,
			).filter(
				({ opcode, attributes }) =>
					opcode === "typeofCompare" ||
					(opcode === "unary" &&
						(attributes.operator === "typeof" || attributes.operator === "!")) ||
					(opcode === "binary" &&
						(attributes.operator === "===" || attributes.operator === "!==")),
			);
		const baseline = compile(true);
		const optimized = compile(false);
		expect(observations(baseline)).toHaveLength(3);
		expect(observations(optimized)).toEqual([]);
		expect(
			optimized.functions[functionIndexOfName(optimized, "observe")]!.blocks.flatMap(
				({ instructions }) => instructions,
			).some(
				({ opcode, attributes }) =>
					opcode === "createBoolean" && attributes.value === true,
			),
		).toBe(true);
	});

	it("removes TDZ checks only when Core SSA excludes the Empty sentinel", () => {
		const optimizedOpcodes = (source: string): Array<string> => {
			const semantic = analyzeSourceAndRunSemanticAnalysis(source, "core-tdz.js");
			let opcodes: Array<string> = [];
			compileSemanticProgramToProgramImage(semantic, {
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

	it("keeps source-closed binding cells initialized across value-clobbering effects", () => {
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
		const opcodes = optimized.functions.flatMap(({ blocks }) =>
			blocks.flatMap(({ instructions }) => instructions.map(({ opcode }) => opcode)),
		);

		expect(strings).toEqual(["", "café 🐊", "constants"]);
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
		const opcodes = optimized.functions.flatMap(({ blocks }) =>
			blocks.flatMap(({ instructions }) => instructions.map(({ opcode }) => opcode)),
		);

		expect(strings).toContain("value");
		expect(opcodes).toContain("throwIfTdz");
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
					data: {
						call: { $coreInstruction: call.id },
						license: {
							guard: "structural",
							genericTwin: "retained",
							materialization: "none",
							admission: {
								anchor: { $coreInstruction: call.id },
								validity: "once",
							},
						},
					},
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
					data: {
						producer: { $coreInstruction: claimed.id },
						license: {
							guard: "structural",
							genericTwin: "retained",
							materialization: "none",
							admission: {
								anchor: { $coreInstruction: claimed.id },
								validity: "once",
							},
						},
					},
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
