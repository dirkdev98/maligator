import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/core-target-lowering.ts";

const PASS = "fold-empty-forwarding-blocks";

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

function optimize(fn: CoreFunction): {
	readonly result: CoreFunction;
	readonly folded: boolean;
	readonly program: CoreProgram;
} {
	const outcome = executeCoreOptimizations(coreProgram([fn]));
	return {
		result: outcome.program.functions[0]!,
		folded: outcome.passes.some(({ name, changed }) => name === PASS && changed),
		program: outcome.program,
	};
}

function blockParameters(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
): ReadonlyArray<CoreValueId> {
	return builder.block(block).parameters.map(({ value }) => value);
}

/** Entry branches through two single-parameter forwarding blocks into one join. */
function functionWithForwardedArguments(): CoreFunction {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
	const entry = builder.createBlock([{}]);
	const flag = blockParameters(builder, entry)[0];
	const [left] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 1 },
	});
	const [right] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 2 },
	});
	const consequent = builder.createBlock([{}]);
	const alternate = builder.createBlock([{}]);
	const join = builder.createBlock([{}]);
	builder.setTerminator(entry, {
		kind: "branch",
		condition: flag!,
		consequent: { block: consequent, arguments: [left!] },
		alternate: { block: alternate, arguments: [right!] },
	});
	builder.setTerminator(consequent, {
		kind: "jump",
		edge: {
			block: join,
			arguments: [blockParameters(builder, consequent)[0]!],
		},
	});
	builder.setTerminator(alternate, {
		kind: "jump",
		edge: {
			block: join,
			arguments: [blockParameters(builder, alternate)[0]!],
		},
	});
	builder.setTerminator(join, {
		kind: "return",
		value: blockParameters(builder, join)[0]!,
	});
	return builder.finish(entry);
}

describe("Core empty forwarding blocks", () => {
	it("substitutes edge arguments through a forwarding block", () => {
		const { result, folded } = optimize(functionWithForwardedArguments());
		expect(folded).toBe(true);
		const entryTerminator = result.blocks[result.entry]!.terminator;
		expect(entryTerminator.kind).toBe("branch");
		if (entryTerminator.kind !== "branch") throw new Error("expected a branch");
		// Both arms now carry the original argument straight to the join.
		expect(entryTerminator.consequent.block).toBe(entryTerminator.alternate.block);
		expect(entryTerminator.consequent.arguments).not.toEqual(
			entryTerminator.alternate.arguments,
		);
		expect(result.blocks).toHaveLength(2);
		expect(() =>
			verifyCoreProgram(coreProgram([result]), coreOpcodeRegistry),
		).not.toThrow();
	});

	it("collapses a chain of forwarding blocks in one pass", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const first = builder.createBlock([{}]);
		const second = builder.createBlock([{}]);
		const exit = builder.createBlock([{}]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: first, arguments: [value!] },
		});
		builder.setTerminator(first, {
			kind: "jump",
			edge: {
				block: second,
				arguments: [blockParameters(builder, first)[0]!],
			},
		});
		builder.setTerminator(second, {
			kind: "jump",
			edge: {
				block: exit,
				arguments: [blockParameters(builder, second)[0]!],
			},
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: blockParameters(builder, exit)[0]!,
		});

		const { result, folded } = optimize(builder.finish(entry));
		expect(folded).toBe(true);
		// The whole chain is gone; the return sees the entry's own value.
		expect(result.blocks.length).toBeLessThan(4);
		expect(() =>
			verifyCoreProgram(coreProgram([result]), coreOpcodeRegistry),
		).not.toThrow();
	});

	it("terminates on a forwarding cycle and preserves the cycle", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const flag = blockParameters(builder, entry)[0];
		const spin = builder.createBlock();
		const other = builder.createBlock();
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag!,
			consequent: { block: spin, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(spin, { kind: "jump", edge: { block: other, arguments: [] } });
		builder.setTerminator(other, { kind: "jump", edge: { block: spin, arguments: [] } });
		builder.setTerminator(exit, { kind: "return", value: flag! });

		const { result, folded } = optimize(builder.finish(entry));
		expect(folded).toBe(false);
		const cfg = buildCoreControlFlow(result, coreOpcodeRegistry);
		// CFG normalization may change the number of forwarding blocks, but it must
		// preserve a reachable cycle instead of chasing it forever.
		expect(cfg.loops).toHaveLength(1);
		expect(() =>
			verifyCoreProgram(coreProgram([result]), coreOpcodeRegistry),
		).not.toThrow();
	});

	it("never folds a handler entry whose parameter the unwinder binds", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const object = blockParameters(builder, entry)[0]!;
		const handler = builder.createBlock([{ role: "exception" }]);
		const rethrow = builder.createBlock([{}]);
		// A protected block always holds the throwing operation itself, so a handler
		// entry is the only exceptional block that can look like a forwarding block.
		const [value] = builder.appendInstruction(entry, "loadPropertyStatic", [object], {
			attributes: { stringIndex: 0 },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "return", value: value! });
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: rethrow, arguments: [blockParameters(builder, handler)[0]!] },
		});
		builder.setTerminator(rethrow, {
			kind: "throw",
			value: blockParameters(builder, rethrow)[0]!,
		});

		const { result, folded } = optimize(builder.finish(entry));
		expect(folded).toBe(false);
		const protectedBlock = result.blocks.find(({ handler: edge }) => edge !== undefined)!;
		const handlerEntry = result.blocks[protectedBlock.handler!.block]!;
		expect(handlerEntry.parameters[0]?.role).toBe("exception");
		expect(handlerEntry.instructions).toHaveLength(0);
	});

	it("retains a forwarding phi used by a dominated block", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const flag = blockParameters(builder, entry)[0]!;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const forward = builder.createBlock([{}]);
		const exit = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [one] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(right, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: forward, arguments: [one!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: forward, arguments: [two!] },
		});
		builder.setTerminator(forward, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: blockParameters(builder, forward)[0]!,
		});

		const fn = builder.finish(entry);
		const phi = fn.blocks[forward]!.parameters[0]!.value;
		const outcome = executeCoreOptimizations(coreProgram([fn]), {
			verification: "per-pass",
		});
		const result = outcome.program.functions[0]!;
		expect(result.values.some(({ id }) => id === phi)).toBe(true);
		expect(() => verifyCoreProgram(outcome.program, coreOpcodeRegistry)).not.toThrow();
	});

	it("threads edge-specific constants through an empty branch", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const flag = blockParameters(builder, entry)[0]!;
		const left = builder.createBlock();
		const right = builder.createBlock();
		const decision = builder.createBlock([{ representation: "boolean" }]);
		const success = builder.createBlock();
		const failure = builder.createBlock();
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [truthy] = builder.appendInstruction(left, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		const [falsy] = builder.appendInstruction(right, "createBoolean", [], {
			attributes: { value: false },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: decision, arguments: [truthy!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: decision, arguments: [falsy!] },
		});
		builder.setTerminator(decision, {
			kind: "branch",
			condition: blockParameters(builder, decision)[0]!,
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

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			verification: "per-pass",
		});
		const branches = outcome.program.functions[0]!.blocks.filter(
			({ terminator }) => terminator.kind === "branch",
		);
		expect(branches).toHaveLength(1);
		expect(() => verifyCoreProgram(outcome.program, coreOpcodeRegistry)).not.toThrow();
	});

	it("combines long observable linear chains within one optimization round", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [returned] = builder.appendInstruction(entry, "createUndefined", []);
		let current = entry;
		for (let index = 0; index < 20; index++) {
			const next = builder.createBlock();
			builder.setTerminator(current, {
				kind: "jump",
				edge: { block: next, arguments: [] },
			});
			builder.appendInstruction(next, "createObject", []);
			current = next;
		}
		builder.setTerminator(current, { kind: "return", value: returned! });
		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			maxRounds: 1,
			verification: "per-pass",
		});
		const fn = outcome.program.functions[0]!;
		expect(fn.blocks).toHaveLength(1);
		expect(
			fn.blocks[0]!.instructions.filter(({ opcode }) => opcode === "createObject"),
		).toHaveLength(20);
	});

	it("rewrites dominated uses when a linear merge deletes a narrowed phi", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		// The initially boxed parameter prevents the earlier trivial-argument pass
		// from collapsing it; representation refinement narrows it before block merge.
		const target = builder.createBlock([{}]);
		const exit = builder.createBlock();
		const parameter = blockParameters(builder, target)[0]!;
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [value!] },
		});
		builder.setTerminator(target, {
			kind: "jump",
			edge: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: parameter });

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]), {
			maxRounds: 1,
			verification: "per-pass",
		});
		const fn = outcome.program.functions[0]!;
		expect(fn.blocks).toHaveLength(1);
		expect(fn.blocks[0]!.terminator).toMatchObject({ kind: "return", value });
		expect(fn.values.some(({ id }) => id === parameter)).toBe(false);
	});

	it("reaches a stable fixpoint on a second optimization run", () => {
		const first = optimize(functionWithForwardedArguments());
		const second = executeCoreOptimizations(first.program);
		expect(second.passes.some(({ name, changed }) => name === PASS && changed)).toBe(
			false,
		);
		expect(second.program.functions[0]!.blocks).toEqual(first.result.blocks);
	});
});

describe("Core SSA and CFG cleanup", () => {
	it("removes a join parameter when every reachable edge provides one value", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const flag = blockParameters(builder, entry)[0]!;
		const [value] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{}]);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [value!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [value!] },
		});
		builder.setTerminator(join, {
			kind: "return",
			value: blockParameters(builder, join)[0]!,
		});

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]));
		const result = outcome.program.functions[0]!;
		expect(
			outcome.passes.some(
				({ name, changed }) => name === "eliminate-trivial-block-arguments" && changed,
			),
		).toBe(true);
		expect(
			result.values.some(
				({ definition }) =>
					definition.kind === "block-parameter" && definition.block !== result.entry,
			),
		).toBe(false);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]!.terminator).toMatchObject({ kind: "return", value });
	});

	it("removes unused parameters and their mismatched incoming arguments", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const flag = blockParameters(builder, entry)[0]!;
		const [leftValue] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [rightValue] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const join = builder.createBlock([{}]);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: flag,
			consequent: { block: join, arguments: [leftValue!] },
			alternate: { block: join, arguments: [rightValue!] },
		});
		builder.setTerminator(join, { kind: "return", value: flag });

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]));
		const result = outcome.program.functions[0]!;
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]!.terminator).toMatchObject({ kind: "return", value: flag });
		expect(() =>
			verifyCoreProgram(coreProgram([result]), coreOpcodeRegistry),
		).not.toThrow();
	});

	it("drops an exceptional edge when its protected block can no longer throw", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const handler = builder.createBlock([{ role: "exception" }]);
		const value = blockParameters(builder, entry)[0]!;
		builder.appendInstruction(entry, "unary", [value], {
			attributes: { operator: "typeof" },
		});
		builder.setHandler(entry, handler);
		builder.setTerminator(entry, { kind: "return", value });
		builder.setTerminator(handler, {
			kind: "throw",
			value: blockParameters(builder, handler)[0]!,
		});

		const outcome = executeCoreOptimizations(coreProgram([builder.finish(entry)]));
		const result = outcome.program.functions[0]!;
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]!.handler).toBeUndefined();
	});
});

describe("Core to target boundary", () => {
	it("emits every Core block instead of absorbing forwarding arms", () => {
		// Unoptimized Core keeps the empty branch arms that target lowering used to
		// absorb on its own; lowering must now emit each of them.
		const compilation = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.pick = function pick(flag) {
					if (flag) {} else {}
					return flag;
				};`,
				"forwarding-boundary.js",
			),
		);
		const core = compilation.program;
		const owner = core.functions.find((fn) =>
			fn.blocks.some(
				(block) =>
					block.id !== fn.entry &&
					block.instructions.length === 0 &&
					block.handler === undefined &&
					block.terminator.kind === "jump",
			),
		)!;
		const forwarding = owner.blocks.filter(
			(block) =>
				block.id !== owner.entry &&
				block.instructions.length === 0 &&
				block.handler === undefined &&
				block.terminator.kind === "jump",
		);
		expect(forwarding.length).toBeGreaterThan(0);
		const branchArms = owner.blocks.flatMap(({ terminator }) =>
			terminator.kind === "branch"
				? [terminator.consequent.block, terminator.alternate.block]
				: [],
		);
		expect(forwarding.some(({ id }) => branchArms.includes(id))).toBe(true);

		const lowered = lowerCoreCompilationToExecution(compilation);
		const loweredOwner = lowered.functions[owner.functionIndex]!;
		// Edge copies may add blocks; nothing may remove one.
		expect(loweredOwner.blocks.length).toBeGreaterThanOrEqual(owner.blocks.length);
		const executable = loweredOwner.blocks.map(({ instructions }) =>
			instructions.filter(({ type }) => type !== "sourcePos"),
		);
		expect(
			executable.filter(
				(instructions) => instructions.length === 1 && instructions[0]!.type === "jump",
			).length,
		).toBeGreaterThanOrEqual(forwarding.length);
	});
});
