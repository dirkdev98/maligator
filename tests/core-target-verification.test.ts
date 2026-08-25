import { describe, expect, it } from "vitest";
import type { CoreCompilation } from "../src/compiler/core/core-compilation.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import type { CoreProgram } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import type { CompilerInstruction } from "../src/compiler/shared/compiler-instruction.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/core-target-lowering.ts";
import type {
	ExecutionFunction,
	ExecutionProgram,
} from "../src/compiler/target/core-target-lowering.ts";
import {
	ExecutionVerificationError,
	verifyExecutionProgram,
} from "../src/compiler/target/core-target-verifier.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-vm.ts";

const BRANCH_SOURCE = `
	function choose(flag, extra) {
		let value = 1;
		if (flag) value = 2 + extra;
		else value = 3;
		return value;
	}
	choose(true, 4);
`;

const HANDLER_SOURCE = `
	function preserve(object, callback) {
		try {
			callback();
			return object.value;
		} catch (error) {
			return object.value + String(error).length;
		}
	}
	preserve({ value: 2 }, () => { throw new Error("x"); });
`;

const NESTED_HANDLER_SOURCE = `
	function nested(callback, report) {
		try {
			try {
				callback();
			} catch ({ value }) {
				return value;
			}
		} catch (outer) {
			return report(outer);
		}
	}
	nested(() => { throw { value: 2 }; }, (value) => String(value));
`;

/** Loop-carried rotation, so an edge copy needs a cycle-breaking temporary. */
const LOOP_SOURCE = `
	function rotate(count, seed) {
		let left = seed;
		let right = seed + 1;
		for (let index = 0; index < count; index++) {
			const held = left;
			left = right;
			right = held + index;
		}
		return left + right;
	}
	rotate(4, 1);
`;

/** Selects an overlay numeric-fusion certificate. */
const REGION_SOURCE = `
	function project(value) {
		const fields = value.split(";");
		const total = fields.length + fields.length * 2;
		return fields[1] + total;
	}
	project("a;b");
`;

/** Selects a projection certificate, which also translates result registers. */
const PROJECTION_SOURCE = `
	function fields(value) {
		const parts = value.split(";");
		return parts[1] + parts.length;
	}
	fields("a;b");
`;

const SUPER_SOURCE = `
	class Parent {}
	class Child extends Parent {
		constructor() {
			super();
			this.repeat = () => super();
		}
	}
	new Child();
`;

const ARGUMENTS_SOURCE = `
	function sum(first) {
		return arguments.length + arguments[0] + first;
	}
	sum(1, 2);
`;

function optimizedCore(source: string, path: string): CoreCompilation {
	const semantic = analyzeSourceAndRunSemanticAnalysis(source, path);
	const lowered = lowerSemanticProgramToCore(semantic);
	const optimized = executeCoreOptimizations(lowered.program, {
		context: lowered.context,
	});
	if (optimized.context === undefined) throw new Error("optimization lost context");
	return { program: optimized.program, context: optimized.context };
}

function optimizedTarget(source: string, path: string): ExecutionProgram {
	return lowerCoreCompilationToExecution(optimizedCore(source, path));
}

function withFunction(
	program: ExecutionProgram,
	index: number,
	patch: Partial<ExecutionFunction>,
): ExecutionProgram {
	return {
		...program,
		functions: program.functions.with(index, {
			...program.functions[index]!,
			...patch,
		}),
	};
}

function withBlock(
	fn: ExecutionFunction,
	block: number,
	instructions: Array<CompilerInstruction>,
): Partial<ExecutionFunction> {
	return { blocks: fn.blocks.with(block, { instructions }) };
}

function withRegisters(
	instruction: CompilerInstruction,
	registers: Array<number>,
): CompilerInstruction {
	return { ...instruction, registers } as CompilerInstruction;
}

function verificationError(program: ExecutionProgram): ExecutionVerificationError {
	try {
		verifyExecutionProgram(program);
	} catch (error) {
		if (error instanceof ExecutionVerificationError) return error;
		throw error;
	}
	throw new Error("expected Core target verification to reject the program");
}

interface InstructionMatch {
	readonly functionIndex: number;
	readonly fn: ExecutionFunction;
	readonly block: number;
	readonly index: number;
	readonly instruction: CompilerInstruction;
}

function findInstruction(
	program: ExecutionProgram,
	predicate: (instruction: CompilerInstruction, fn: ExecutionFunction) => boolean,
): InstructionMatch {
	for (const [functionIndex, fn] of program.functions.entries()) {
		for (const [block, { instructions }] of fn.blocks.entries()) {
			for (const [index, instruction] of instructions.entries()) {
				if (predicate(instruction, fn)) {
					return { functionIndex, fn, block, index, instruction };
				}
			}
		}
	}
	throw new Error("no matching target instruction in the lowered program");
}

function registerOf(instruction: CompilerInstruction, position: number): number {
	const registers = (instruction as { readonly registers?: ReadonlyArray<number> })
		.registers;
	const register = registers?.[position];
	if (register === undefined) throw new Error("instruction lacks the register operand");
	return register;
}

describe("Core target construction", () => {
	it("verifies representative lowered source through every target contract", () => {
		for (const [name, source] of [
			["branches", BRANCH_SOURCE],
			["handlers", HANDLER_SOURCE],
			["nested-handlers", NESTED_HANDLER_SOURCE],
			["loops", LOOP_SOURCE],
			["regions", REGION_SOURCE],
			["projections", PROJECTION_SOURCE],
			["two-address", SUPER_SOURCE],
			["arguments", ARGUMENTS_SOURCE],
		] as const) {
			const program = optimizedTarget(source, `${name}.js`);
			expect(() => verifyExecutionProgram(program)).not.toThrow();
			expect(() => lowerExecutionToProgramImage(program)).not.toThrow();
		}
	});

	it("lowers branches and block arguments into verified parallel edge copies", () => {
		const program = optimizedTarget(BRANCH_SOURCE, "verified-branches.js");
		const copies = program.functions.flatMap(({ parallelCopies }) => parallelCopies);

		expect(copies.map(({ kind }) => kind)).toContain("edge");
		expect(
			program.functions.flatMap((fn) =>
				fn.blocks.flatMap(({ instructions }) =>
					instructions.filter(({ type }) => type === "jumpIf"),
				),
			).length,
		).toBeGreaterThan(0);
		for (const copy of copies) {
			expect(copy.moves.length).toBeGreaterThan(0);
			expect(copy.assignments.length).toBeGreaterThan(0);
		}
	});

	it("lowers handlers with a declared handler-input copy contract", () => {
		const program = optimizedTarget(HANDLER_SOURCE, "verified-handlers.js");
		const owner = program.functions.find((fn) =>
			fn.parallelCopies.some(({ kind }) => kind === "handler-input"),
		)!;
		const protectedBlock = owner.blocks.find(
			({ instructions }) => instructions[0]?.type === "tryBegin",
		)!;
		const opening = protectedBlock.instructions[0]!;
		if (opening.type !== "tryBegin") throw new Error("missing protected range");
		const handler = owner.blocks[opening.blocks[0]]!;

		expect(handler.instructions.filter(({ type }) => type === "catch")).toHaveLength(1);
		expect(
			protectedBlock.instructions.filter(({ type }) => type === "tryEnd"),
		).toHaveLength(1);
	});

	it("orders handler inputs before catch when an exception entry is itself protected", () => {
		const program = optimizedTarget(NESTED_HANDLER_SOURCE, "verified-nested-handler.js");
		const match = program.functions
			.flatMap((fn, functionIndex) => {
				const handlerTargets = new Set(
					fn.blocks.flatMap(({ instructions }) =>
						instructions.flatMap((instruction) =>
							instruction.type === "tryBegin" ? [instruction.blocks[0]] : [],
						),
					),
				);
				return [...handlerTargets].map((block) => ({
					functionIndex,
					fn,
					block,
					instructions: fn.blocks[block]!.instructions,
				}));
			})
			.find(({ instructions }) => instructions[0]?.type === "tryBegin");
		expect(match).toBeDefined();
		const copy = match!.fn.parallelCopies.find(
			(candidate) =>
				candidate.kind === "handler-input" &&
				match!.instructions.includes(candidate.moves[0]!),
		);
		expect(copy).toBeDefined();
		expect(match!.instructions.slice(1, copy!.moves.length + 1)).toEqual(copy!.moves);
		expect(match!.instructions[copy!.moves.length + 1]?.type).toBe("catch");

		const marker = match!.instructions.find(({ type }) => type === "sourcePos");
		if (marker?.type !== "sourcePos") throw new Error("missing source position");
		const catchIndex = copy!.moves.length + 1;
		const marked = withFunction(
			program,
			match!.functionIndex,
			withBlock(match!.fn, match!.block, [
				...match!.instructions.slice(0, catchIndex),
				{ ...marker },
				...match!.instructions.slice(catchIndex),
			]),
		);
		expect(() => verifyExecutionProgram(marked)).not.toThrow();
		expect(() => lowerExecutionToProgramImage(marked)).not.toThrow();
	});

	it("records safepoints and boxed GC roots for allocating source", () => {
		const program = optimizedTarget(HANDLER_SOURCE, "verified-safepoints.js");
		for (const [index, fn] of program.functions.entries()) {
			const roots = program.gcRootRegisters[index];
			expect(roots === undefined).toBe(fn.isGenerator || fn.isAsync);
			for (const register of roots ?? []) {
				expect(fn.registerRepresentations[register]).toBe("boxed");
			}
		}
		expect(
			program.functions.flatMap(({ safepoints }) => safepoints).length,
		).toBeGreaterThan(0);
	});

	it("constrains two-address operations to one register", () => {
		for (const [source, type] of [
			[SUPER_SOURCE, "constructSuperExplicit"],
			[ARGUMENTS_SOURCE, "loadStaticArgument"],
		] as const) {
			const program = optimizedTarget(source, `verified-${type}.js`);
			const operations = program.functions.flatMap((fn) =>
				fn.blocks.flatMap(({ instructions }) =>
					instructions.filter((instruction) => instruction.type === type),
				),
			);

			expect(operations.length).toBeGreaterThan(0);
			for (const operation of operations) {
				const [result, operand] = type === "constructSuperExplicit" ? [0, 4] : [1, 3];
				expect(registerOf(operation, result)).toBe(registerOf(operation, operand));
			}
		}
	});

	it("verifies region-selected source with translated instructions and blocks", () => {
		for (const source of [REGION_SOURCE, PROJECTION_SOURCE]) {
			const program = optimizedTarget(source, "verified-regions.js");
			const owner = program.functions.find((fn) => fn.specializations.length > 0)!;
			const instructions = new Set(
				owner.blocks.flatMap(({ instructions: block }) => block),
			);

			expect(owner.specializations.length).toBeGreaterThan(0);
			for (const region of owner.specializations) {
				expect(region.anchors.length).toBeGreaterThan(0);
				for (const anchor of region.anchors) expect(instructions.has(anchor)).toBe(true);
				for (const claimed of region.claimedInstructions) {
					expect(instructions.has(claimed)).toBe(true);
				}
				for (const block of region.controlFlow.ordinaryBlocks) {
					expect(block).toBeLessThan(owner.blocks.length);
				}
				for (const register of "resultRegisters" in region
					? region.resultRegisters
					: []) {
					expect(register).toBeLessThan(owner.registerCount);
				}
			}
		}
	});

	it("breaks parallel-copy cycles through declared temporary registers", () => {
		const program = optimizedTarget(LOOP_SOURCE, "verified-cycle.js");
		const owner = program.functions.find((fn) =>
			fn.parallelCopies.some(({ temporaries }) => temporaries.length > 0),
		)!;
		const cycle = owner.parallelCopies.find(({ temporaries }) => temporaries.length > 0)!;

		expect(
			cycle.moves.filter(({ registers }) => cycle.temporaries.includes(registers[0])),
		).toHaveLength(cycle.temporaries.length);
		for (const temporary of cycle.temporaries) {
			expect(owner.temporaryRegisters).toContain(temporary);
			expect(temporary).toBeGreaterThanOrEqual(owner.parameterCount);
			expect(owner.registerRepresentations[temporary]).toBeDefined();
		}
	});

	it("rejects a Core-to-target class mismatch at the construction boundary", () => {
		const compilation = optimizedCore(BRANCH_SOURCE, "boundary.js");
		const core = compilation.program;
		const functionIndex = core.functions.findIndex((fn) =>
			fn.blocks.some(
				(block, index) =>
					index !== fn.entry && block.parameters.some(({ role }) => role === "value"),
			),
		);
		const owner = core.functions[functionIndex]!;
		const blockIndex = owner.blocks.findIndex(
			(block, index) =>
				index !== owner.entry && block.parameters.some(({ role }) => role === "value"),
		);
		const block = owner.blocks[blockIndex]!;
		const parameter = block.parameters.find(({ role }) => role === "value")!;
		// Core accepts an f64 parameter fed by boxed edge arguments; the target ABI
		// cannot, because the edge copy would have to narrow its source register.
		const retyped: CoreProgram = {
			...core,
			functions: core.functions.with(functionIndex, {
				...owner,
				values: owner.values.map((value) =>
					value.id === parameter.value ? { ...value, representation: "f64" } : value,
				),
				blocks: owner.blocks.with(blockIndex, {
					...block,
					parameters: block.parameters.map((candidate) =>
						candidate.value === parameter.value
							? { ...candidate, representation: "f64" }
							: candidate,
					),
				}),
			}),
		};

		expect(() =>
			lowerCoreCompilationToExecution({ ...compilation, program: retyped }),
		).toThrow(ExecutionVerificationError);
	});
});

describe("Core target verification", () => {
	it("rejects a function table that disagrees with the Core program", () => {
		const program = optimizedTarget(BRANCH_SOURCE, "cardinality.js");
		expect(program.functions.length).toBeGreaterThan(1);

		const dropped = verificationError({
			...program,
			functions: program.functions.slice(1),
		});
		expect(dropped.detail).toMatch(
			/^target program holds \d+ functions for a \d+-function Core program$/,
		);

		const misindexed = verificationError(withFunction(program, 1, { functionIndex: 0 }));
		expect(misindexed.detail).toBe(
			"target function index 0 is stored at program index 1",
		);
		expect(misindexed.context).toMatchObject({ functionIndex: 1 });

		const renamed = verificationError(
			withFunction(program, 1, {
				nameStringIndex: program.functions[1]!.nameStringIndex + 1,
			}),
		);
		expect(renamed.detail).toBe(
			"target function metadata nameStringIndex does not match its Core function",
		);
		expect(renamed.context).toMatchObject({ functionIndex: 1 });
	});

	it("rejects out-of-bounds register operands and a broken representation table", () => {
		const program = optimizedTarget(BRANCH_SOURCE, "registers.js");
		const match = findInstruction(program, ({ type }) => type === "move");
		const outOfBounds = verificationError(
			withFunction(
				program,
				match.functionIndex,
				withBlock(
					match.fn,
					match.block,
					match.fn.blocks[match.block]!.instructions.with(
						match.index,
						withRegisters(match.instruction, [
							match.fn.registerCount,
							registerOf(match.instruction, 1),
						]),
					),
				),
			),
		);
		expect(outOfBounds.detail).toBe(
			`register operand is out of bounds for a ${match.fn.registerCount}-register function`,
		);
		expect(outOfBounds.context).toMatchObject({
			functionIndex: match.functionIndex,
			block: match.block,
			instruction: match.index,
			opcode: "move",
			register: match.fn.registerCount,
		});

		const fn = program.functions[0]!;
		const truncated = verificationError(
			withFunction(program, 0, {
				registerRepresentations: fn.registerRepresentations.slice(1),
			}),
		);
		expect(truncated.detail).toBe(
			`register representation table holds ${fn.registerRepresentations.length - 1} entries for a ${fn.registerCount}-register function`,
		);
		expect(truncated.context).toMatchObject({ functionIndex: 0 });

		const classError = verificationError(
			withFunction(program, 0, {
				registerRepresentations: fn.registerRepresentations.with(
					fn.registerCount - 1,
					"f64" as "boxed",
				),
			}),
		);
		expect(classError.detail).toBe("register class must be boxed, number, or boolean");
		expect(classError.context).toMatchObject({
			functionIndex: 0,
			register: fn.registerCount - 1,
		});
	});

	it("rejects an unboxed parameter ABI slot", () => {
		const program = optimizedTarget(BRANCH_SOURCE, "parameter-abi.js");
		const functionIndex = program.functions.findIndex(
			({ parameterCount }) => parameterCount > 0,
		);
		const fn = program.functions[functionIndex]!;
		const error = verificationError(
			withFunction(program, functionIndex, {
				registerRepresentations: fn.registerRepresentations.with(0, "number"),
			}),
		);

		expect(error.detail).toBe("parameter ABI slot must be a boxed register");
		expect(error.context).toMatchObject({ functionIndex, register: 0 });
	});

	it("rejects a parallel copy that narrows a class, loses its semantics, or invents a temporary", () => {
		const program = optimizedTarget(LOOP_SOURCE, "parallel-copies.js");
		const functionIndex = program.functions.findIndex((fn) =>
			fn.parallelCopies.some(({ assignments }) =>
				assignments.some(
					({ destination }) => fn.registerRepresentations[destination] === "number",
				),
			),
		);
		const fn = program.functions[functionIndex]!;
		const copyIndex = fn.parallelCopies.findIndex(({ assignments }) =>
			assignments.some(
				({ destination }) => fn.registerRepresentations[destination] === "number",
			),
		);
		const copy = fn.parallelCopies[copyIndex]!;
		const assignmentIndex = copy.assignments.findIndex(
			({ destination }) => fn.registerRepresentations[destination] === "number",
		);
		const assignment = copy.assignments[assignmentIndex]!;
		const boxed = fn.registerRepresentations.indexOf("boxed");

		const narrowing = verificationError(
			withFunction(program, functionIndex, {
				parallelCopies: fn.parallelCopies.with(copyIndex, {
					...copy,
					assignments: copy.assignments.with(assignmentIndex, {
						destination: assignment.destination,
						source: boxed,
					}),
				}),
			}),
		);
		expect(narrowing.detail).toBe(
			"parallel copy must not narrow a source register class",
		);
		expect(narrowing.context).toMatchObject({
			functionIndex,
			register: assignment.destination,
		});

		const cycleIndex = fn.parallelCopies.findIndex(
			({ temporaries }) => temporaries.length > 0,
		);
		const cycle = fn.parallelCopies[cycleIndex]!;
		const undeclared = fn.registerRepresentations.findIndex(
			(_, register) => !fn.temporaryRegisters.includes(register),
		);
		const foreignTemporary = verificationError(
			withFunction(program, functionIndex, {
				parallelCopies: fn.parallelCopies.with(cycleIndex, {
					...cycle,
					temporaries: [undeclared],
				}),
			}),
		);
		expect(foreignTemporary.detail).toBe(
			"parallel copy uses an undeclared temporary register",
		);
		expect(foreignTemporary.context).toMatchObject({
			functionIndex,
			register: undeclared,
		});

		const brokenCycle = verificationError(
			withFunction(program, functionIndex, {
				parallelCopies: fn.parallelCopies.with(cycleIndex, {
					...cycle,
					moves: cycle.moves.slice(1),
				}),
			}),
		);
		expect(brokenCycle.detail).toBe(
			"emitted moves do not implement the declared parallel copy",
		);
		expect(brokenCycle.context).toMatchObject({ functionIndex });
	});

	it("rejects an invalid handler target, unbalanced nesting, or a displaced handler-input copy", () => {
		const program = optimizedTarget(HANDLER_SOURCE, "handlers.js");
		const match = findInstruction(program, ({ type }) => type === "tryBegin");
		const instructions = match.fn.blocks[match.block]!.instructions;
		const opening = instructions[0]!;
		if (opening.type !== "tryBegin") throw new Error("missing protected range");

		const unknownTarget = verificationError(
			withFunction(
				program,
				match.functionIndex,
				withBlock(
					match.fn,
					match.block,
					instructions.with(0, {
						...opening,
						blocks: [match.fn.blocks.length, match.block],
					}),
				),
			),
		);
		expect(unknownTarget.detail).toBe(
			`block operand names unknown block ${match.fn.blocks.length} in a ${match.fn.blocks.length}-block function`,
		);
		expect(unknownTarget.context).toMatchObject({
			functionIndex: match.functionIndex,
			block: match.block,
			instruction: 0,
			opcode: "tryBegin",
		});

		const entryHandler = verificationError(
			withFunction(
				program,
				match.functionIndex,
				withBlock(
					match.fn,
					match.block,
					instructions.with(0, {
						...opening,
						blocks: [0, match.block],
					}),
				),
			),
		);
		expect(entryHandler.detail).toBe(
			"function entry block may not be an exception-handler block",
		);
		expect(entryHandler.context).toMatchObject({
			functionIndex: match.functionIndex,
			block: 0,
		});

		const unbalanced = verificationError(
			withFunction(
				program,
				match.functionIndex,
				withBlock(
					match.fn,
					match.block,
					instructions.filter(({ type }) => type !== "tryEnd"),
				),
			),
		);
		expect(unbalanced.detail).toBe("block opens 1 protected ranges and closes 0");
		expect(unbalanced.context).toMatchObject({
			functionIndex: match.functionIndex,
			block: match.block,
		});

		const copyOwner = program.functions.findIndex((fn) =>
			fn.parallelCopies.some(({ kind }) => kind === "handler-input"),
		);
		const owner = program.functions[copyOwner]!;
		const copy = owner.parallelCopies.find(({ kind }) => kind === "handler-input")!;
		const copyBlock = owner.blocks.findIndex(({ instructions: block }) =>
			block.includes(copy.moves[0]!),
		);
		const displaced = verificationError(
			withFunction(
				program,
				copyOwner,
				withBlock(owner, copyBlock, [
					owner.blocks[copyBlock]!.instructions[0]!,
					{ type: "sourcePos", pos: 0 },
					...owner.blocks[copyBlock]!.instructions.slice(1),
				]),
			),
		);
		expect(displaced.detail).toBe(
			"handler-input copy must follow the tryBegin of its protected block",
		);
		expect(displaced.context).toMatchObject({
			functionIndex: copyOwner,
			block: copyBlock,
			opcode: "handler-input",
		});
	});

	it("rejects ordinary control flow into an exception entry", () => {
		const program = optimizedTarget(HANDLER_SOURCE, "handler-entry.js");
		const opening = findInstruction(program, ({ type }) => type === "tryBegin");
		if (opening.instruction.type !== "tryBegin")
			throw new Error("missing protected range");
		const handler = opening.instruction.blocks[0];
		const transfer = findInstruction(
			program,
			(instruction, fn) =>
				fn === opening.fn &&
				(instruction.type === "jump" || instruction.type === "jumpIf") &&
				instruction.blocks[0] !== handler,
		);
		if (transfer.instruction.type !== "jump" && transfer.instruction.type !== "jumpIf") {
			throw new Error("missing ordinary transfer");
		}
		const malformed = withFunction(
			program,
			transfer.functionIndex,
			withBlock(
				transfer.fn,
				transfer.block,
				transfer.fn.blocks[transfer.block]!.instructions.with(transfer.index, {
					...transfer.instruction,
					blocks: [handler],
				}),
			),
		);
		const error = verificationError(malformed);

		expect(error.detail).toBe(
			"ordinary control flow may not target an exception-handler block",
		);
		expect(error.context).toMatchObject({
			functionIndex: transfer.functionIndex,
			block: transfer.block,
			instruction: transfer.index,
			opcode: transfer.instruction.type,
		});
		expect(() => lowerExecutionToProgramImage(malformed)).toThrow(
			ExecutionVerificationError,
		);

		const precedingBlock = handler - 1;
		const preceding = opening.fn.blocks[precedingBlock]!.instructions;
		const transferIndex = preceding.findLastIndex(({ type }) =>
			["jump", "return", "throw"].includes(type),
		);
		expect(transferIndex).toBeGreaterThanOrEqual(0);
		const fallthrough = withFunction(
			program,
			opening.functionIndex,
			withBlock(opening.fn, precedingBlock, preceding.toSpliced(transferIndex, 1)),
		);
		const fallthroughError = verificationError(fallthrough);
		expect(fallthroughError.detail).toBe(
			"ordinary fallthrough may not enter an exception-handler block",
		);
		expect(fallthroughError.context).toMatchObject({
			functionIndex: opening.functionIndex,
			block: precedingBlock,
		});
	});

	it("requires catch to establish handler state before ordinary instructions", () => {
		const program = optimizedTarget(HANDLER_SOURCE, "handler-catch-order.js");
		const opening = findInstruction(program, ({ type }) => type === "tryBegin");
		if (opening.instruction.type !== "tryBegin")
			throw new Error("missing protected range");
		const handlerBlock = opening.instruction.blocks[0];
		const instructions = opening.fn.blocks[handlerBlock]!.instructions;
		const catchIndex = instructions.findIndex(({ type }) => type === "catch");
		expect(catchIndex).toBeGreaterThanOrEqual(0);
		const malformed = withFunction(
			program,
			opening.functionIndex,
			withBlock(opening.fn, handlerBlock, [
				...instructions.slice(0, catchIndex),
				{ type: "move", registers: [0, 0] },
				...instructions.slice(catchIndex),
			]),
		);
		const error = verificationError(malformed);

		expect(error.detail).toBe(
			"exception-handler block must define its exception before ordinary instructions",
		);
		expect(error.context).toMatchObject({
			functionIndex: opening.functionIndex,
			block: handlerBlock,
			instruction: catchIndex,
			opcode: "move",
		});
	});

	it("rejects executable instructions after an unconditional transfer", () => {
		const program = optimizedTarget(BRANCH_SOURCE, "transfer-tail.js");
		const transfer = findInstruction(
			program,
			(instruction, fn) => instruction.type === "jump" && fn.registerCount > 0,
		);
		const instructions = transfer.fn.blocks[transfer.block]!.instructions;
		const marker = transfer.fn.blocks
			.flatMap(({ instructions: block }) => block)
			.find(({ type }) => type === "sourcePos");
		if (marker?.type !== "sourcePos") throw new Error("missing source position");
		const marked = withFunction(
			program,
			transfer.functionIndex,
			withBlock(transfer.fn, transfer.block, [
				...instructions.slice(0, transfer.index + 1),
				{ ...marker },
				...instructions.slice(transfer.index + 1),
			]),
		);
		expect(() => verifyExecutionProgram(marked)).not.toThrow();
		expect(() => lowerExecutionToProgramImage(marked)).not.toThrow();

		const malformed = withFunction(
			program,
			transfer.functionIndex,
			withBlock(transfer.fn, transfer.block, [
				...instructions.slice(0, transfer.index + 1),
				{ type: "move", registers: [0, 0] },
				...instructions.slice(transfer.index + 1),
			]),
		);
		const error = verificationError(malformed);

		expect(error.detail).toBe(
			"unconditional control transfer must end its containing block",
		);
		expect(error.context).toMatchObject({
			functionIndex: transfer.functionIndex,
			block: transfer.block,
			instruction: transfer.index,
			opcode: "jump",
		});
	});

	it("rejects GC roots that are out of bounds, unboxed, duplicated, or missing at a safepoint", () => {
		const program = optimizedTarget(HANDLER_SOURCE, "gc-roots.js");
		const functionIndex = program.functions.findIndex(
			(fn, index) =>
				(program.gcRootRegisters[index] ?? []).length > 0 &&
				fn.safepoints.some(
					({ instruction }) => instruction.type === "loadPropertyStatic",
				),
		);
		const fn = program.functions[functionIndex]!;
		const roots = program.gcRootRegisters[functionIndex]!;
		const withRoots = (replacement: ReadonlyArray<number>): ExecutionProgram => ({
			...program,
			gcRootRegisters: program.gcRootRegisters.with(functionIndex, replacement),
		});

		const outOfBounds = verificationError(withRoots([...roots, fn.registerCount]));
		expect(outOfBounds.detail).toBe(
			`GC root register is out of bounds for a ${fn.registerCount}-register function`,
		);
		expect(outOfBounds.context).toMatchObject({
			functionIndex,
			register: fn.registerCount,
		});

		const numeric = optimizedTarget(LOOP_SOURCE, "gc-roots-unboxed.js");
		const numericIndex = numeric.functions.findIndex(
			(candidate, index) =>
				(numeric.gcRootRegisters[index] ?? []).length > 0 &&
				candidate.registerRepresentations.includes("number"),
		);
		const unboxed =
			numeric.functions[numericIndex]!.registerRepresentations.indexOf("number");
		const unboxedRoot = verificationError({
			...numeric,
			gcRootRegisters: numeric.gcRootRegisters.with(numericIndex, [
				...numeric.gcRootRegisters[numericIndex]!,
				unboxed,
			]),
		});
		expect(unboxedRoot.detail).toBe("GC root register must be boxed");
		expect(unboxedRoot.context).toMatchObject({
			functionIndex: numericIndex,
			register: unboxed,
		});

		const duplicated = verificationError(withRoots([...roots, roots[0]!]));
		expect(duplicated.detail).toBe("GC root register is listed twice");
		expect(duplicated.context).toMatchObject({ functionIndex, register: roots[0] });

		const load = fn.safepoints.find(
			({ instruction }) => instruction.type === "loadPropertyStatic",
		)!.instruction;
		const object = registerOf(load, 1);
		const missing = verificationError(
			withRoots(roots.filter((register) => register !== object)),
		);
		expect(missing.detail).toBe("boxed register live at a safepoint is not a GC root");
		expect(missing.context).toMatchObject({ functionIndex, register: object });
		// The first safepoint that still needs the register reports it; every
		// safepoint carries its own block, position, and operation.
		expect(missing.context.block).toBeGreaterThanOrEqual(0);
		expect(missing.context.instruction).toBeGreaterThanOrEqual(0);
		expect(
			fn.safepoints.some(
				({ instruction }) => instruction.type === missing.context.opcode,
			),
		).toBe(true);

		const omittedSafepoint = fn.safepoints[0]!;
		const stillCovered = new Set(
			fn.safepoints
				.slice(1)
				.flatMap(({ realizedCoreInstructions }) => realizedCoreInstructions),
		);
		const omittedCoreInstruction = omittedSafepoint.realizedCoreInstructions.find(
			(instruction) => !stillCovered.has(instruction),
		)!;
		const incomplete = verificationError(
			withFunction(program, functionIndex, {
				safepoints: fn.safepoints.slice(1),
			}),
		);
		expect(incomplete.detail).toBe(
			`Core safepoint @${omittedCoreInstruction} has no target safepoint record`,
		);
		expect(incomplete.context).toMatchObject({ functionIndex });
	});

	it("rejects a violated two-address instruction constraint", () => {
		for (const [source, type, operand, requirement] of [
			[
				SUPER_SOURCE,
				"constructSuperExplicit",
				4,
				"one register for its current-this operand and its result",
			],
			[
				ARGUMENTS_SOURCE,
				"loadStaticArgument",
				3,
				"one register for both of its fallback-cache operands",
			],
		] as const) {
			const program = optimizedTarget(source, `two-address-${type}.js`);
			const match = findInstruction(program, (instruction) => instruction.type === type);
			const registers = [
				...(match.instruction as { readonly registers: ReadonlyArray<number> }).registers,
			];
			const result = type === "constructSuperExplicit" ? 0 : 1;
			registers[operand] = registers.findIndex(
				(register, index) => index !== operand && register !== registers[result],
			);
			const error = verificationError(
				withFunction(
					program,
					match.functionIndex,
					withBlock(
						match.fn,
						match.block,
						match.fn.blocks[match.block]!.instructions.with(
							match.index,
							withRegisters(match.instruction, registers),
						),
					),
				),
			);

			expect(error.detail).toBe(`two-address instruction must use ${requirement}`);
			expect(error.context).toMatchObject({
				functionIndex: match.functionIndex,
				block: match.block,
				instruction: match.index,
				opcode: type,
				register: registers[result],
			});
		}
	});

	it("rejects region data that leaves the function it was translated for", () => {
		const program = optimizedTarget(PROJECTION_SOURCE, "regions.js");
		// A projection region carries translated registers as well as blocks.
		const functionIndex = program.functions.findIndex((candidate) =>
			candidate.specializations.some((region) => "resultRegisters" in region),
		);
		const fn = program.functions[functionIndex]!;
		const regionIndex = fn.specializations.findIndex(
			(region) => "resultRegisters" in region,
		);
		const region = fn.specializations[regionIndex]!;
		const withRegion = (patch: object): ExecutionProgram =>
			withFunction(program, functionIndex, {
				specializations: fn.specializations.with(regionIndex, { ...region, ...patch }),
			});

		const foreignAnchor = verificationError(
			withRegion({
				anchors: [{ type: "move", registers: [0, 0] }, ...region.anchors.slice(1)],
			}),
		);
		expect(foreignAnchor.detail).toBe("region anchor does not belong to this function");
		expect(foreignAnchor.context).toMatchObject({
			functionIndex,
			opcode: region.kind,
		});

		const foreignClaim = verificationError(
			withRegion({
				claimedInstructions: [
					...region.claimedInstructions,
					{ type: "move", registers: [0, 0] },
				],
			}),
		);
		expect(foreignClaim.detail).toBe(
			"region claimed instruction does not belong to this function",
		);

		const unknownBlock = verificationError(
			withRegion({
				controlFlow: {
					ordinaryBlocks: [fn.blocks.length],
					exceptionalBlocks: [],
				},
			}),
		);
		expect(unknownBlock.detail).toBe(
			`region ordinary block ${fn.blocks.length} is not a block of this ${fn.blocks.length}-block function`,
		);

		expect(region).toHaveProperty("resultRegisters");
		const unknownRegister = verificationError(
			withRegion({ resultRegisters: [fn.registerCount] }),
		);
		expect(unknownRegister.detail).toBe(
			`region register is out of bounds for a ${fn.registerCount}-register function`,
		);
		expect(unknownRegister.context).toMatchObject({
			functionIndex,
			opcode: region.kind,
			register: fn.registerCount,
		});
	});

	it("requires stack-object access slots to name the accessed allocation key", () => {
		const program = optimizedTarget(
			`function read(value, replace) {
				const object = { first: value, second: 2 };
				if (replace) object.second = 1;
				return object.second;
			}
			read(3, false);`,
			"stack-object-slot-key.js",
		);
		expect(() => lowerExecutionToProgramImage(program)).not.toThrow();
		const functionIndex = program.functions.findIndex((fn) =>
			fn.specializations.some((region) => region.kind === "stack-object-plan"),
		);
		const fn = program.functions[functionIndex]!;
		const regionIndex = fn.specializations.findIndex(
			(region) => region.kind === "stack-object-plan",
		);
		const region = fn.specializations[regionIndex]!;
		if (region.kind !== "stack-object-plan") throw new Error("expected stack region");
		const site = region.sites[0]!;
		expect(site.slotCount).toBeGreaterThan(1);
		expect(new Set(site.accesses.map(({ instruction }) => instruction.type))).toEqual(
			new Set(["loadPropertyStatic", "storePropertyStatic"]),
		);
		for (const [accessIndex, access] of site.accesses.entries()) {
			const malformed = withFunction(program, functionIndex, {
				specializations: fn.specializations.with(regionIndex, {
					...region,
					sites: region.sites.with(0, {
						...site,
						accesses: site.accesses.with(accessIndex, {
							...access,
							slot: access.slot === 0 ? 1 : 0,
						}),
					}),
				}),
			});

			expect(() => verifyExecutionProgram(malformed)).not.toThrow();
			expect(() => lowerExecutionToProgramImage(malformed)).toThrow(
				/Invalid Core stack-object-plan region during VM lowering: site instruction metadata/,
			);
		}
	});

	it("rejects a temporary register read before its definition or without a class", () => {
		const program = optimizedTarget(SUPER_SOURCE, "temporaries.js");
		const match = findInstruction(
			program,
			(instruction, fn) =>
				instruction.type === "constructSuperExplicit" &&
				fn.temporaryRegisters.includes(registerOf(instruction, 0)),
		);
		const constrained = registerOf(match.instruction, 0);
		const instructions = match.fn.blocks[match.block]!.instructions;
		const definition = instructions.findIndex(
			(instruction, index) =>
				index < match.index &&
				instruction.type === "move" &&
				instruction.registers[0] === constrained,
		);
		expect(definition).toBeGreaterThanOrEqual(0);
		const source = registerOf(instructions[definition]!, 1);
		const undefinedRead = verificationError(
			withFunction(
				program,
				match.functionIndex,
				withBlock(
					match.fn,
					match.block,
					instructions.with(definition, { type: "move", registers: [source, source] }),
				),
			),
		);
		expect(undefinedRead.detail).toBe("temporary register is read before its definition");
		expect(undefinedRead.context).toMatchObject({
			functionIndex: match.functionIndex,
			block: match.block,
			instruction: match.index,
			opcode: "constructSuperExplicit",
			register: constrained,
		});

		const undeclared = match.fn.temporaryRegisters.find(
			(register) => register >= match.fn.allocatedRegisterCount,
		)!;
		const incomplete = verificationError(
			withFunction(program, match.functionIndex, {
				temporaryRegisters: match.fn.temporaryRegisters.filter(
					(register) => register !== undeclared,
				),
			}),
		);
		expect(incomplete.detail).toBe(
			"register introduced after allocation is not declared temporary",
		);
		expect(incomplete.context).toMatchObject({
			functionIndex: match.functionIndex,
			register: undeclared,
		});

		const outOfBounds = verificationError(
			withFunction(program, match.functionIndex, {
				temporaryRegisters: [...match.fn.temporaryRegisters, match.fn.registerCount],
			}),
		);
		expect(outOfBounds.detail).toBe(
			`temporary register is out of bounds for a ${match.fn.registerCount}-register function`,
		);
		expect(outOfBounds.context).toMatchObject({
			functionIndex: match.functionIndex,
			register: match.fn.registerCount,
		});
	});
});
