import { coreOpcodeRegistry, isCoreOpcode } from "../core/core-ir-opcodes.ts";
import type { CoreAllocatedRegion } from "../core/core-ir-regions.ts";
import type { CoreInstructionId } from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import { COMPILER_TWO_ADDRESS_OPERANDS } from "../shared/compiler-instruction.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import { coreInstructionNeedsOperationSafepoint } from "./core-operation-contract.ts";
import type {
	ExecutionFunction,
	ExecutionParallelCopy,
	ExecutionProgram,
} from "./execution-ir.ts";
import {
	executionLoopBackedgeInstructions,
	executionSafepointRoots,
} from "./execution-liveness.ts";

export interface ExecutionVerificationContext {
	readonly functionIndex?: number;
	readonly block?: number;
	/** Position of the instruction inside its own block. */
	readonly instruction?: number;
	readonly opcode?: string;
	readonly register?: number;
}

function formatContext(context: ExecutionVerificationContext): string {
	const parts: Array<string> = [];
	if (context.functionIndex !== undefined)
		parts.push(`function=${context.functionIndex}`);
	if (context.block !== undefined) parts.push(`block=${context.block}`);
	if (context.instruction !== undefined) parts.push(`instruction=${context.instruction}`);
	if (context.opcode !== undefined) parts.push(`op=${context.opcode}`);
	if (context.register !== undefined) parts.push(`register=r${context.register}`);
	return parts.length === 0 ? "" : ` [${parts.join(" ")}]`;
}

export class ExecutionVerificationError extends Error {
	/** Invariant text without the context prefix, so callers can match it directly. */
	readonly detail: string;
	readonly context: ExecutionVerificationContext;

	constructor(detail: string, context: ExecutionVerificationContext = {}) {
		super(`Core target verification failed${formatContext(context)}: ${detail}`);
		this.name = "ExecutionVerificationError";
		this.detail = detail;
		this.context = context;
	}
}

function fail(detail: string, context: ExecutionVerificationContext = {}): never {
	throw new ExecutionVerificationError(detail, context);
}

interface OperandShape {
	/** Leading register operands the instruction defines. */
	readonly writes: number;
	readonly minimumRegisters: number;
	readonly maximumRegisters: number;
	readonly blocks: number;
}

/**
 * Control flow, exception entry, and source positions are structural Core concepts
 * that cannot be Core opcodes, so their operand shape is stated here. Every other
 * target instruction must answer to the Core opcode registry instead: a second
 * opcode table would be free to drift away from the arities Core already enforces.
 */
const STRUCTURAL_SHAPES: Readonly<Record<string, OperandShape>> = {
	sourcePos: { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 0 },
	jump: { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 1 },
	jumpIf: { writes: 0, minimumRegisters: 1, maximumRegisters: 1, blocks: 1 },
	tryBegin: { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 2 },
	tryEnd: { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 0 },
	catch: { writes: 1, minimumRegisters: 1, maximumRegisters: 1, blocks: 0 },
	return: { writes: 0, minimumRegisters: 1, maximumRegisters: 1, blocks: 0 },
	throw: { writes: 0, minimumRegisters: 1, maximumRegisters: 1, blocks: 0 },
};

/** Instructions that end a block; anything else falls through to the next block. */
const BLOCK_TERMINATORS: ReadonlySet<string> = new Set(["jump", "return", "throw"]);

/** Last instruction that transfers control, ignoring markers that carry no opcode. */
function lastExecutable(
	instructions: ReadonlyArray<CompilerInstruction>,
): CompilerInstruction | undefined {
	for (let index = instructions.length - 1; index >= 0; index--) {
		const instruction = instructions[index]!;
		if (
			instruction.type !== "sourcePos" &&
			instruction.type !== "rootUse" &&
			instruction.type !== "tryEnd"
		) {
			return instruction;
		}
	}
	return undefined;
}

function fallsThrough(instructions: ReadonlyArray<CompilerInstruction>): boolean {
	const last = lastExecutable(instructions);
	return last === undefined || !BLOCK_TERMINATORS.has(last.type);
}

function operandShape(type: string, context: ExecutionVerificationContext): OperandShape {
	const structural = STRUCTURAL_SHAPES[type];
	if (structural !== undefined) return structural;
	if (!isCoreOpcode(type)) {
		fail("instruction is neither a Core opcode nor a structural target form", context);
	}
	const descriptor = coreOpcodeRegistry.require(type);
	if (descriptor.outputs.minimum !== descriptor.outputs.maximum) {
		fail("instruction opcode has a variable result count", context);
	}
	const writes = descriptor.outputs.minimum;
	return {
		writes,
		minimumRegisters: writes + descriptor.inputs.minimum,
		maximumRegisters: writes + descriptor.inputs.maximum,
		blocks: 0,
	};
}

function instructionRegisters(
	instruction: CompilerInstruction,
): ReadonlyArray<number> | undefined {
	return (instruction as { readonly registers?: ReadonlyArray<number> }).registers;
}

function instructionBlocks(
	instruction: CompilerInstruction,
): ReadonlyArray<number> | undefined {
	return (instruction as { readonly blocks?: ReadonlyArray<number> }).blocks;
}

function instructionImmediates(
	instruction: CompilerInstruction,
): ReadonlyArray<unknown> | undefined {
	return (instruction as { readonly immediateValues?: ReadonlyArray<unknown> })
		.immediateValues;
}

interface InstructionSite {
	readonly block: number;
	readonly index: number;
	readonly shape: OperandShape;
}

interface FunctionModel {
	readonly fn: ExecutionFunction;
	readonly functionIndex: number;
	readonly sites: ReadonlyMap<CompilerInstruction, InstructionSite>;
	readonly handlerTargets: ReadonlySet<number>;
}

function isBoxed(fn: ExecutionFunction, register: number): boolean {
	return fn.registerRepresentations[register] === "boxed";
}

function isRooted(fn: ExecutionFunction, register: number): boolean {
	const representation = fn.registerRepresentations[register];
	return representation === "boxed" || representation === "string";
}

function reads(
	instruction: CompilerInstruction,
	shape: OperandShape,
): ReadonlyArray<number> {
	const registers = instructionRegisters(instruction) ?? [];
	return registers.slice(shape.writes).filter((register) => register >= 0);
}

function writes(
	instruction: CompilerInstruction,
	shape: OperandShape,
): ReadonlyArray<number> {
	const registers = instructionRegisters(instruction) ?? [];
	return registers.slice(0, shape.writes).filter((register) => register >= 0);
}

function verifyProgramCardinality(program: ExecutionProgram): void {
	const core = program.core;
	if (program.functionMap.executionToCore.length !== program.functions.length) {
		fail("execution-to-Core function map does not match the target function table");
	}
	const mapped = new Set(program.functionMap.executionToCore);
	if (mapped.size !== program.functionMap.executionToCore.length) {
		fail("execution-to-Core function map contains a duplicate Core identity");
	}
	for (const coreFunction of core.functionIds()) {
		const execution = program.functionMap.coreToExecution[coreFunction];
		if ((execution === -1) !== !mapped.has(coreFunction)) {
			fail(`Core function ${coreFunction} has an inconsistent target mapping`);
		}
	}
	for (const [index, fn] of program.functions.entries()) {
		const context: ExecutionVerificationContext = { functionIndex: index };
		const coreFunctionId = program.functionMap.executionToCore[index];
		if (coreFunctionId === undefined) {
			fail("target function has no Core function identity", context);
		}
		const coreFunction = core.function(coreFunctionId);
		if (
			fn.coreBlocks.length === 0 ||
			fn.coreBlocks[0] !== coreFunction.entry ||
			new Set(fn.coreBlocks).size !== fn.coreBlocks.length ||
			fn.coreBlocks.some((block) => !coreFunction.isBlockLive(block))
		) {
			fail("target Core block mapping is invalid", context);
		}
		if (
			fn.functionIndex !== index ||
			program.functionMap.coreToExecution[coreFunctionId] !== index
		) {
			fail(
				`target function index ${fn.functionIndex} is stored at program index ${index}`,
				context,
			);
		}
		const mirrored: ReadonlyArray<readonly [string, unknown, unknown]> = [
			["sourcePath", fn.sourcePath, coreFunction.metadata.sourcePath],
			["nameStringIndex", fn.nameStringIndex, coreFunction.metadata.nameStringIndex],
			["isGenerator", fn.isGenerator, coreFunction.isGenerator],
			["isAsync", fn.isAsync, coreFunction.isAsync],
			["parameterCount", fn.parameterCount, coreFunction.parameterCount],
			["length", fn.length, coreFunction.metadata.length],
			["capturedCount", fn.capturedCount, coreFunction.metadata.capturedCount],
			["strict", fn.strict, coreFunction.metadata.strict],
			[
				"isClassConstructor",
				fn.isClassConstructor,
				coreFunction.metadata.isClassConstructor,
			],
			[
				"isDerivedConstructor",
				fn.isDerivedConstructor,
				coreFunction.metadata.isDerivedConstructor,
			],
			["hasPrototype", fn.hasPrototype, coreFunction.metadata.hasPrototype],
			["mappedArguments", fn.mappedArguments, coreFunction.metadata.mappedArguments],
			[
				"mappedArgumentSlots",
				fn.mappedArgumentSlots.join(","),
				[...coreFunction.metadata.mappedArgumentSlots].join(","),
			],
		];
		for (const [name, target, expected] of mirrored) {
			if (target !== expected) {
				fail(
					`target function metadata ${name} does not match its Core function`,
					context,
				);
			}
		}
		if (fn.nameStringIndex >= core.stringConstants.length) {
			fail(
				`target function names unknown string constant ${fn.nameStringIndex}`,
				context,
			);
		}
	}
}

function buildFunctionModel(fn: ExecutionFunction, functionIndex: number): FunctionModel {
	const sites = new Map<CompilerInstruction, InstructionSite>();
	const handlerTargets = new Set<number>();
	if (fn.blocks.length === 0) fail("target function has no blocks", { functionIndex });
	for (const [block, { instructions }] of fn.blocks.entries()) {
		for (const [index, instruction] of instructions.entries()) {
			const context: ExecutionVerificationContext = {
				functionIndex,
				block,
				instruction: index,
				opcode: instruction.type,
			};
			if (sites.has(instruction)) {
				fail("instruction appears at more than one position", context);
			}
			sites.set(instruction, {
				block,
				index,
				shape: operandShape(instruction.type, context),
			});
			if (instruction.type === "tryBegin") handlerTargets.add(instruction.blocks[0]);
		}
	}
	return { fn, functionIndex, sites, handlerTargets };
}

function verifyRegisterPlan(model: FunctionModel): void {
	const { fn, functionIndex } = model;
	const context: ExecutionVerificationContext = { functionIndex };
	if (!Number.isSafeInteger(fn.registerCount) || fn.registerCount < 0) {
		fail(`invalid register count ${fn.registerCount}`, context);
	}
	if (fn.registerRepresentations.length !== fn.registerCount) {
		fail(
			`register representation table holds ${fn.registerRepresentations.length} entries for a ${fn.registerCount}-register function`,
			context,
		);
	}
	if (
		!Number.isSafeInteger(fn.allocatedRegisterCount) ||
		fn.allocatedRegisterCount < fn.parameterCount ||
		fn.allocatedRegisterCount > fn.registerCount
	) {
		fail(
			`invalid allocated register count ${fn.allocatedRegisterCount} for a ${fn.registerCount}-register function`,
			context,
		);
	}
	for (const [register, representation] of fn.registerRepresentations.entries()) {
		if (
			representation !== "boxed" &&
			representation !== "int32" &&
			representation !== "number" &&
			representation !== "boolean" &&
			representation !== "string"
		) {
			fail("register class must be boxed, int32, number, boolean, or string", {
				...context,
				register,
			});
		}
	}
	if (fn.parameterCount > fn.registerCount) {
		fail(
			`parameter ABI needs ${fn.parameterCount} registers in a ${fn.registerCount}-register function`,
			context,
		);
	}
	// Every incoming argument is a MalValue, so the ABI prefix cannot be unboxed.
	for (let register = 0; register < fn.parameterCount; register++) {
		if (!isBoxed(fn, register)) {
			fail("parameter ABI slot must be a boxed register", { ...context, register });
		}
	}
}

function verifyInstructionOperands(model: FunctionModel): void {
	const { fn, functionIndex } = model;
	for (const [block, { instructions }] of fn.blocks.entries()) {
		let previousSemanticInstruction: CompilerInstruction | undefined;
		for (const [index, instruction] of instructions.entries()) {
			const context: ExecutionVerificationContext = {
				functionIndex,
				block,
				instruction: index,
				opcode: instruction.type,
			};
			const shape = model.sites.get(instruction)!.shape;
			const registers = instructionRegisters(instruction);
			const count = registers?.length ?? 0;
			if (count < shape.minimumRegisters || count > shape.maximumRegisters) {
				fail(
					`instruction takes ${count} register operands, expected ${shape.minimumRegisters}..${shape.maximumRegisters}`,
					context,
				);
			}
			const immediates = instructionImmediates(instruction);
			const embeddable =
				instruction.type === "call" ||
				instruction.type === "callKnown" ||
				instruction.type === "construct";
			for (const [position, register] of (registers ?? []).entries()) {
				const operandContext = { ...context, register };
				if (register === -1) {
					if (!embeddable || position < shape.writes) {
						fail("only a call-like operand may drop its register", {
							...context,
						});
					}
					if (immediates?.[position] === undefined) {
						fail("dropped register operand has no embedded immediate value", context);
					}
					continue;
				}
				if (
					!Number.isSafeInteger(register) ||
					register < 0 ||
					register >= fn.registerCount
				) {
					fail(
						`register operand is out of bounds for a ${fn.registerCount}-register function`,
						operandContext,
					);
				}
				if (immediates?.[position] !== undefined) {
					fail(
						"embedded immediate value must replace its register operand",
						operandContext,
					);
				}
			}
			if (immediates !== undefined && immediates.length > count) {
				fail("embedded immediate values exceed the register operands", context);
			}
			const blocks = instructionBlocks(instruction);
			if ((blocks?.length ?? 0) !== shape.blocks) {
				fail(
					`instruction takes ${blocks?.length ?? 0} block operands, expected ${shape.blocks}`,
					context,
				);
			}
			for (const target of blocks ?? []) {
				if (!Number.isSafeInteger(target) || target < 0 || target >= fn.blocks.length) {
					fail(
						`block operand names unknown block ${target} in a ${fn.blocks.length}-block function`,
						context,
					);
				}
			}
			const twoAddress = COMPILER_TWO_ADDRESS_OPERANDS[instruction.type];
			if (
				twoAddress !== undefined &&
				registers?.[twoAddress.result] !== registers?.[twoAddress.operand]
			) {
				fail(`two-address instruction must use ${twoAddress.requirement}`, {
					...context,
					register: registers?.[twoAddress.result],
				});
			}
			if (instruction.type === "move") {
				const [destination, source] = instruction.registers;
				const destinationRepresentation = fn.registerRepresentations[destination];
				const sourceRepresentation = fn.registerRepresentations[source];
				const provenNarrowing =
					sourceRepresentation === "boxed" &&
					instruction.exactScalarAfterTdz?.kind === destinationRepresentation &&
					previousSemanticInstruction?.type === "throwIfTdz" &&
					previousSemanticInstruction.registers[0] === source;
				const numericWidening =
					sourceRepresentation === "int32" && destinationRepresentation === "number";
				if (
					destinationRepresentation !== sourceRepresentation &&
					!isBoxed(fn, destination) &&
					!provenNarrowing &&
					!numericWidening
				) {
					fail("move must not narrow its source register class", {
						...context,
						register: destination,
					});
				}
				if (instruction.exactScalarAfterTdz !== undefined && !provenNarrowing) {
					fail("post-TDZ scalar move carries an invalid narrowing proof", {
						...context,
						register: destination,
					});
				}
			}
			if (instruction.type !== "sourcePos" && instruction.type !== "rootUse") {
				previousSemanticInstruction = instruction;
			}
		}
	}
}

function verifyBlockStructure(model: FunctionModel): void {
	const { fn, functionIndex } = model;
	if (model.handlerTargets.has(0)) {
		fail("function entry block may not be an exception-handler block", {
			functionIndex,
			block: 0,
		});
	}
	for (const [block, { instructions }] of fn.blocks.entries()) {
		const context: ExecutionVerificationContext = { functionIndex, block };
		let begins = 0;
		let ends = 0;
		let catches = 0;
		for (const [index, instruction] of instructions.entries()) {
			const site = { ...context, instruction: index, opcode: instruction.type };
			if (
				(instruction.type === "jump" || instruction.type === "jumpIf") &&
				model.handlerTargets.has(instruction.blocks[0])
			) {
				fail("ordinary control flow may not target an exception-handler block", site);
			}
			if (
				BLOCK_TERMINATORS.has(instruction.type) &&
				instructions
					.slice(index + 1)
					.some(({ type }) => type !== "sourcePos" && type !== "tryEnd")
			) {
				fail("unconditional control transfer must end its containing block", site);
			}
			if (instruction.type === "tryBegin") {
				begins++;
				if (index !== 0) {
					fail("protected range must open at the start of its block", site);
				}
				if (instruction.blocks[1] !== block) {
					fail("tryBegin must name its own protected block", site);
				}
				if (instruction.blocks[0] === block) {
					fail("protected block cannot be its own exception handler", site);
				}
			}
			if (instruction.type === "tryEnd") {
				ends++;
				if (index !== instructions.length - 1) {
					fail("protected range must close at the end of its block", site);
				}
			}
			if (instruction.type === "catch") {
				catches++;
				if (!model.handlerTargets.has(block)) {
					fail("catch may only appear in an exception-handler block", site);
				}
			}
		}
		if (ends !== begins) {
			fail(`block opens ${begins} protected ranges and closes ${ends}`, context);
		}
		if (model.handlerTargets.has(block) && catches !== 1) {
			fail(
				`exception-handler block defines its exception ${catches} times, expected once`,
				context,
			);
		}
		if (fallsThrough(instructions)) {
			if (block + 1 >= fn.blocks.length) {
				fail("final block must end in a control transfer", context);
			}
			if (model.handlerTargets.has(block + 1)) {
				fail("ordinary fallthrough may not enter an exception-handler block", context);
			}
		}
	}
}

/** Symbolic parallel-copy state: which register's entry value each register holds. */
function simulateParallelCopy(
	model: FunctionModel,
	copy: ExecutionParallelCopy,
	context: ExecutionVerificationContext,
): void {
	const { fn } = model;
	const declaredTemporaries = new Set(fn.temporaryRegisters);
	for (const temporary of copy.temporaries) {
		if (!declaredTemporaries.has(temporary)) {
			fail("parallel copy uses an undeclared temporary register", {
				...context,
				register: temporary,
			});
		}
	}
	// Two parameters of one block share a register when they are the same canonical
	// Core value, and then every edge must supply that value once. Repeating a
	// destination with a second source instead would drop one of the two writes.
	const destinations = new Map<number, number>();
	for (const { destination, source } of copy.assignments) {
		for (const register of [destination, source]) {
			if (
				!Number.isSafeInteger(register) ||
				register < 0 ||
				register >= fn.registerCount
			) {
				fail("parallel copy operand is out of bounds", { ...context, register });
			}
		}
		const existing = destinations.get(destination);
		if (existing !== undefined && existing !== source) {
			fail("parallel copy assigns one register two different sources", {
				...context,
				register: destination,
			});
		}
		destinations.set(destination, source);
		const destinationRepresentation = fn.registerRepresentations[destination];
		const sourceRepresentation = fn.registerRepresentations[source];
		if (
			destinationRepresentation !== sourceRepresentation &&
			!(sourceRepresentation === "int32" && destinationRepresentation === "number") &&
			!isBoxed(fn, destination)
		) {
			fail("parallel copy must not narrow a source register class", {
				...context,
				register: destination,
			});
		}
	}
	const held = new Map<number, number>();
	const entryValue = (register: number): number => held.get(register) ?? register;
	for (const move of copy.moves) {
		const site = model.sites.get(move);
		if (site === undefined) {
			fail("declared parallel-copy move is not present in this function", context);
		}
		held.set(move.registers[0], entryValue(move.registers[1]));
	}
	for (const { destination, source } of copy.assignments) {
		if (entryValue(destination) !== source) {
			fail("emitted moves do not implement the declared parallel copy", {
				...context,
				register: destination,
			});
		}
	}
	for (const [register, value] of held) {
		if (
			value !== register &&
			!destinations.has(register) &&
			!copy.temporaries.includes(register)
		) {
			fail("parallel copy clobbers a register outside its contract", {
				...context,
				register,
			});
		}
	}
}

function verifyParallelCopies(model: FunctionModel): void {
	const { fn, functionIndex } = model;
	const claimed = new Set<CompilerInstruction>();
	for (const copy of fn.parallelCopies) {
		const first = copy.moves[0];
		if (first === undefined) {
			fail("parallel copy declares no moves", { functionIndex });
		}
		const firstSite = model.sites.get(first);
		if (firstSite === undefined) {
			fail("declared parallel-copy move is not present in this function", {
				functionIndex,
			});
		}
		const context: ExecutionVerificationContext = {
			functionIndex,
			block: firstSite.block,
			instruction: firstSite.index,
			opcode: copy.kind,
		};
		for (const [offset, move] of copy.moves.entries()) {
			const site = model.sites.get(move);
			if (
				site === undefined ||
				site.block !== firstSite.block ||
				site.index !== firstSite.index + offset
			) {
				fail("parallel-copy moves must run contiguously inside one block", context);
			}
			if (claimed.has(move)) {
				fail("move belongs to more than one parallel copy", context);
			}
			claimed.add(move);
		}
		if (copy.kind === "handler-input") {
			const opening = fn.blocks[firstSite.block]!.instructions[0];
			if (opening?.type !== "tryBegin" || firstSite.index !== 1) {
				fail(
					"handler-input copy must follow the tryBegin of its protected block",
					context,
				);
			}
		}
		simulateParallelCopy(model, copy, context);
	}
}

/**
 * Catch consumes VM exception state rather than an ordinary predecessor value. A
 * handler that is itself protected may first open its nested range and initialize
 * that range's explicit handler inputs, but no ordinary instruction may run before
 * the catch establishes the current exception register.
 */
function verifyExceptionEntries(model: FunctionModel): void {
	const { fn, functionIndex } = model;
	const handlerInputCopies = new Map<number, ExecutionParallelCopy>();
	for (const copy of fn.parallelCopies) {
		if (copy.kind !== "handler-input") continue;
		const site = model.sites.get(copy.moves[0]!);
		if (site !== undefined) handlerInputCopies.set(site.block, copy);
	}
	for (const block of model.handlerTargets) {
		const instructions = fn.blocks[block]!.instructions;
		let catchIndex = instructions[0]?.type === "tryBegin" ? 1 : 0;
		const copy = handlerInputCopies.get(block);
		if (copy !== undefined) catchIndex += copy.moves.length;
		while (instructions[catchIndex]?.type === "sourcePos") catchIndex++;
		if (instructions[catchIndex]?.type !== "catch") {
			fail(
				"exception-handler block must define its exception before ordinary instructions",
				{
					functionIndex,
					block,
					instruction: catchIndex,
					opcode: instructions[catchIndex]?.type,
				},
			);
		}
	}
}

function verifyTemporaryRegisters(model: FunctionModel): void {
	const { fn, functionIndex } = model;
	const seen = new Set<number>();
	for (const temporary of fn.temporaryRegisters) {
		const context: ExecutionVerificationContext = {
			functionIndex,
			register: temporary,
		};
		if (
			!Number.isSafeInteger(temporary) ||
			temporary < 0 ||
			temporary >= fn.registerCount
		) {
			fail(
				`temporary register is out of bounds for a ${fn.registerCount}-register function`,
				context,
			);
		}
		if (fn.registerRepresentations[temporary] === undefined) {
			fail("temporary register has no register class", context);
		}
		if (temporary < fn.allocatedRegisterCount) {
			fail("temporary register must be introduced after Core allocation", context);
		}
		if (seen.has(temporary)) fail("temporary register is declared twice", context);
		seen.add(temporary);
	}
	for (
		let temporary = fn.allocatedRegisterCount;
		temporary < fn.registerCount;
		temporary++
	) {
		if (!seen.has(temporary)) {
			fail("register introduced after allocation is not declared temporary", {
				functionIndex,
				register: temporary,
			});
		}
	}
	if (seen.size === 0) return;
	// Lowering introduces temporaries only inside the block that consumes them, so a
	// definition must precede every read without relying on cross-block dataflow.
	const owner = new Map<number, number>();
	for (const [block, { instructions }] of fn.blocks.entries()) {
		const defined = new Set<number>();
		for (const [index, instruction] of instructions.entries()) {
			const shape = model.sites.get(instruction)!.shape;
			const context: ExecutionVerificationContext = {
				functionIndex,
				block,
				instruction: index,
				opcode: instruction.type,
			};
			for (const register of reads(instruction, shape)) {
				if (!seen.has(register) || defined.has(register)) continue;
				fail("temporary register is read before its definition", {
					...context,
					register,
				});
			}
			for (const register of writes(instruction, shape)) {
				if (!seen.has(register)) continue;
				const existing = owner.get(register);
				if (existing !== undefined && existing !== block) {
					fail("temporary register is defined in more than one block", {
						...context,
						register,
					});
				}
				owner.set(register, block);
				defined.add(register);
			}
		}
	}
	for (const temporary of seen) {
		if (!owner.has(temporary)) {
			fail("temporary register is never defined", { functionIndex, register: temporary });
		}
	}
}

function verifyGcRoots(model: FunctionModel, core: CoreFunctionStore): void {
	const { fn, functionIndex } = model;
	const reachable = new Set(fn.coreBlocks);
	const expected = new Set<CoreInstructionId>();
	const coreInstructions = new Set<CoreInstructionId>();
	for (const instruction of core.instructionIds()) {
		if (core.instructionKind(instruction) !== "operation") continue;
		coreInstructions.add(instruction);
		if (
			reachable.has(core.instructionBlock(instruction)) &&
			coreInstructionNeedsOperationSafepoint(core, instruction)
		) {
			expected.add(instruction);
		}
	}
	const safepoints = new Set<CompilerInstruction>();
	const expectedBackedges = executionLoopBackedgeInstructions(fn);
	const recordedBackedges = new Set<CompilerInstruction>();
	const recordedOrigins = new Set<number>();
	const covered = new Set<number>();
	for (const safepoint of fn.gc.safepoints) {
		const { instruction, rootRegisters } = safepoint;
		const site = model.sites.get(instruction);
		if (site === undefined) {
			fail("recorded safepoint does not belong to this function", { functionIndex });
		}
		if (safepoints.has(instruction)) {
			fail("instruction has two target safepoint records", {
				functionIndex,
				block: site.block,
				instruction: site.index,
				opcode: instruction.type,
			});
		}
		safepoints.add(instruction);
		const unique = new Set<number>();
		for (const register of rootRegisters) {
			const context: ExecutionVerificationContext = {
				functionIndex,
				block: site.block,
				instruction: site.index,
				opcode: instruction.type,
				register,
			};
			if (
				!Number.isSafeInteger(register) ||
				register < 0 ||
				register >= fn.registerCount
			) {
				fail(
					`GC root register is out of bounds for a ${fn.registerCount}-register function`,
					context,
				);
			}
			if (!isRooted(fn, register)) {
				fail("GC root register must carry a traced value", context);
			}
			if (unique.has(register)) fail("GC root register is listed twice", context);
			unique.add(register);
		}
		if (safepoint.kind === "loop-backedge") {
			if (!expectedBackedges.has(instruction)) {
				fail("loop-backedge safepoint does not name a native polling edge", {
					functionIndex,
					block: site.block,
					instruction: site.index,
					opcode: instruction.type,
				});
			}
			recordedBackedges.add(instruction);
			continue;
		}
		if (safepoint.kind !== "operation") {
			fail("target safepoint has an unknown kind", { functionIndex });
		}
		const { coreInstruction, realizedCoreInstructions } = safepoint;
		if (recordedOrigins.has(coreInstruction)) {
			fail(`Core instruction @${coreInstruction} has two target safepoint records`, {
				functionIndex,
			});
		}
		recordedOrigins.add(coreInstruction);
		if (!coreInstructions.has(coreInstruction)) {
			fail(`target safepoint names unknown Core instruction @${coreInstruction}`, {
				functionIndex,
			});
		}
		const originOpcode = core.instructionOpcodeName(coreInstruction);
		if (instruction.type !== originOpcode) {
			fail(
				`Core instruction @${coreInstruction} lowered to ${instruction.type}, expected ${originOpcode}`,
				{ functionIndex },
			);
		}
		const immediates = instructionImmediates(instruction);
		const embeddedSafepoints = new Set<number>();
		const kernel = core.kernel;
		const originInputStart = kernel.instructionOperandStart(coreInstruction);
		const originInputCount = kernel.instructionOperandCount(coreInstruction);
		const originOutputCount = kernel.instructionResultCount(coreInstruction);
		for (let index = 0; index < originInputCount; index++) {
			if (immediates?.[originOutputCount + index] === undefined) continue;
			const input = kernel.operandAt(originInputStart + index);
			if (kernel.valueDefinitionKind(input) === 1) {
				embeddedSafepoints.add(kernel.valueDefinitionOwner(input));
			}
		}
		if (realizedCoreInstructions.length === 0) {
			fail("target safepoint realizes no Core collection point", { functionIndex });
		}
		for (const realized of realizedCoreInstructions) {
			if (!expected.has(realized)) {
				fail(`recorded Core instruction @${realized} is not a safepoint`, {
					functionIndex,
				});
			}
			if (realized !== coreInstruction && !embeddedSafepoints.has(realized)) {
				fail(
					`Core safepoint @${realized} is neither the target origin nor an embedded input`,
					{ functionIndex },
				);
			}
			covered.add(realized);
		}
	}
	const missing = [...expected.keys()].find((instruction) => !covered.has(instruction));
	if (missing !== undefined) {
		fail(`Core safepoint @${missing} has no target safepoint record`, { functionIndex });
	}
	const missingBackedge = [...expectedBackedges].find(
		(instruction) => !recordedBackedges.has(instruction),
	);
	if (missingBackedge !== undefined) {
		const site = model.sites.get(missingBackedge)!;
		fail("native polling edge has no loop-backedge safepoint record", {
			functionIndex,
			block: site.block,
			instruction: site.index,
			opcode: missingBackedge.type,
		});
	}
	const exactRoots = executionSafepointRoots(fn, safepoints);
	for (const safepoint of fn.gc.safepoints) {
		for (const boundary of [
			"rootRegisters",
			"incomingRootRegisters",
			"outgoingRootRegisters",
		] as const) {
			const expectedRoots = exactRoots.get(safepoint.instruction)![boundary];
			const actualRoots = safepoint[boundary];
			const mismatch = Math.max(expectedRoots.length, actualRoots.length);
			for (let index = 0; index < mismatch; index++) {
				if (expectedRoots[index] === actualRoots[index]) continue;
				const site = model.sites.get(safepoint.instruction)!;
				const phase = boundary === "rootRegisters" ? "" : ` (${boundary})`;
				fail(`GC safepoint roots do not match exact execution liveness${phase}`, {
					functionIndex,
					block: site.block,
					instruction: site.index,
					opcode: safepoint.instruction.type,
					register: expectedRoots[index] ?? actualRoots[index],
				});
			}
		}
	}
}

function regionRegisters(region: CoreAllocatedRegion): ReadonlyArray<number> {
	return "resultRegisters" in region ? region.resultRegisters : [];
}

function regionBlocks(region: CoreAllocatedRegion): ReadonlyArray<number> {
	return "exitBlock" in region ? [region.exitBlock] : [];
}

function verifyRegions(model: FunctionModel): void {
	const { fn, functionIndex } = model;
	for (const region of fn.specializations) {
		const context: ExecutionVerificationContext = {
			functionIndex,
			opcode: region.kind,
		};
		const requireOwned = (instruction: CompilerInstruction, role: string): void => {
			const site = model.sites.get(instruction);
			if (site === undefined) {
				fail(`region ${role} does not belong to this function`, context);
			}
			if (
				instruction.type === "sourcePos" ||
				instruction.type === "rootUse" ||
				instruction.type === "tryBegin" ||
				instruction.type === "tryEnd"
			) {
				fail(`region ${role} names a marker rather than an executable instruction`, {
					...context,
					block: site.block,
					instruction: site.index,
				});
			}
		};
		for (const anchor of region.anchors) requireOwned(anchor, "anchor");
		for (const claimed of region.claimedInstructions) {
			requireOwned(claimed, "claimed instruction");
		}
		const claimed = new Set<CompilerInstruction>(region.claimedInstructions);
		for (const anchor of region.anchors) {
			if (!claimed.has(anchor)) fail("region anchor is not claimed", context);
		}
		const admission = region.license.admission;
		requireOwned(admission.anchor, "admission anchor");
		if (!claimed.has(admission.anchor)) {
			fail("region admission anchor is not claimed", context);
		}
		if (
			admission.mode !== "capture" &&
			admission.mode !== "stable" &&
			admission.mode !== "per-use"
		) {
			fail("region admission has an invalid mode", context);
		}
		for (const [role, blocks] of [
			["ordinary", region.controlFlow.ordinaryBlocks],
			["exceptional", region.controlFlow.exceptionalBlocks],
			["translated", regionBlocks(region)],
		] as const) {
			for (const block of blocks) {
				if (!Number.isSafeInteger(block) || block < 0 || block >= fn.blocks.length) {
					fail(
						`region ${role} block ${block} is not a block of this ${fn.blocks.length}-block function`,
						context,
					);
				}
			}
		}
		for (const register of regionRegisters(region)) {
			if (
				!Number.isSafeInteger(register) ||
				register < 0 ||
				register >= fn.registerCount
			) {
				fail(
					`region register is out of bounds for a ${fn.registerCount}-register function`,
					{ ...context, register },
				);
			}
		}
	}
}

/**
 * Throws ExecutionVerificationError when a constructed target program breaks a
 * Core-to-target contract. The verifier proves properties of the program it is
 * given and never repairs one.
 */
export function verifyExecutionFunctionRepresentationVariant(
	fn: ExecutionFunction,
	core: CoreFunctionStore,
	functionIndex: number,
): void {
	const model = buildFunctionModel(fn, functionIndex);
	verifyInstructionOperands(model);
	verifyParallelCopies(model);
	verifyGcRoots(model, core);
}

export function verifyExecutionProgram(program: ExecutionProgram): void {
	verifyProgramCardinality(program);
	const models = program.functions.map((fn, index) => buildFunctionModel(fn, index));
	for (const [index, model] of models.entries()) {
		verifyRegisterPlan(model);
		verifyInstructionOperands(model);
		verifyBlockStructure(model);
		verifyParallelCopies(model);
		verifyExceptionEntries(model);
		verifyTemporaryRegisters(model);
		const coreFunction = program.functionMap.executionToCore[index];
		if (coreFunction === undefined) {
			fail("target function has no Core function identity", { functionIndex: index });
		}
		verifyGcRoots(model, program.core.function(coreFunction));
		verifyRegions(model);
	}
}
