import { coreDirectBuiltinCallbackTarget } from "../core/core-ir-call-targets.ts";
import type { CoreAllocatedRegion } from "../core/core-ir-regions.ts";
import type { CoreInstructionId } from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import { COMPILER_TWO_ADDRESS_OPERANDS } from "../shared/compiler-instruction.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import { knownOperationIndex, knownOperations } from "../shared/known-operations.ts";
import {
	coreInstructionNeedsOperationSafepoint,
	entrySuppliedArgumentRead,
} from "./core-operation-contract.ts";
import type { CoreTargetDischargedSafepoint } from "./core-target-ir.ts";
import type {
	ExecutionFunction,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionSafepointRoots,
} from "./execution-ir.ts";
import {
	executionLoopBackedgeInstructions,
	visitExecutionSafepointRoots,
	nativeLoopBackedgeInstructions,
} from "./execution-liveness.ts";
import { executionOperandShape } from "./execution-operand-shapes.ts";

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

interface FunctionModel {
	readonly fn: ExecutionFunction;
	readonly functionIndex: number;
	readonly sites: ReadonlyMap<CompilerInstruction, number>;
	readonly siteBlocks: ReadonlyArray<number>;
	readonly blockStarts: Uint32Array;
	readonly handlerTargets: ReadonlySet<number>;
}

function failAtInstruction(
	detail: string,
	functionIndex: number,
	block: number,
	index: number,
	opcode: string,
	register?: number,
): never {
	fail(detail, {
		functionIndex,
		block,
		instruction: index,
		opcode,
		...(register === undefined ? {} : { register }),
	});
}

function failAtSite(
	detail: string,
	model: FunctionModel,
	instruction: CompilerInstruction,
	site: number,
	register?: number,
): never {
	const block = model.siteBlocks[site]!;
	failAtInstruction(
		detail,
		model.functionIndex,
		block,
		site - model.blockStarts[block]!,
		instruction.type,
		register,
	);
}

function isBoxed(fn: ExecutionFunction, register: number): boolean {
	return fn.registerRepresentations[register] === "boxed";
}

function isRooted(fn: ExecutionFunction, register: number): boolean {
	const representation = fn.registerRepresentations[register];
	return representation === "boxed" || representation === "string";
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
	if (fn.blocks.length === 0) fail("target function has no blocks", { functionIndex });
	const sites = new Map<CompilerInstruction, number>();
	const siteBlocks: Array<number> = [];
	const blockStarts = new Uint32Array(fn.blocks.length);
	const handlerTargets = new Set<number>();
	for (let block = 0; block < fn.blocks.length; block++) {
		blockStarts[block] = siteBlocks.length;
		const { instructions } = fn.blocks[block]!;
		for (let index = 0; index < instructions.length; index++) {
			const instruction = instructions[index]!;
			if (sites.has(instruction)) {
				failAtInstruction(
					"instruction appears at more than one position",
					functionIndex,
					block,
					index,
					instruction.type,
				);
			}
			sites.set(instruction, siteBlocks.length);
			siteBlocks.push(block);
			if (instruction.type === "tryBegin") handlerTargets.add(instruction.blocks[0]);
		}
	}
	return { fn, functionIndex, sites, siteBlocks, blockStarts, handlerTargets };
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

function verifyInstructionOperands(
	model: FunctionModel,
	unreachableMoves?: ReadonlySet<CompilerInstruction>,
): void {
	const { fn, functionIndex } = model;
	for (let block = 0; block < fn.blocks.length; block++) {
		const { instructions } = fn.blocks[block]!;
		let previousSemanticInstruction: CompilerInstruction | undefined;
		for (let index = 0; index < instructions.length; index++) {
			const instruction = instructions[index]!;
			const opcode = instruction.type;
			const shape = executionOperandShape(opcode);
			if (shape === undefined)
				failAtInstruction(
					"instruction is neither a Core opcode nor a structural target form",
					functionIndex,
					block,
					index,
					opcode,
				);
			if (shape === "variable-outputs")
				failAtInstruction(
					"instruction opcode has a variable result count",
					functionIndex,
					block,
					index,
					opcode,
				);
			const registers = instructionRegisters(instruction);
			const count = registers?.length ?? 0;
			if (count < shape.minimumRegisters || count > shape.maximumRegisters) {
				failAtInstruction(
					`instruction takes ${count} register operands, expected ${shape.minimumRegisters}..${shape.maximumRegisters}`,
					functionIndex,
					block,
					index,
					opcode,
				);
			}
			const immediates = instructionImmediates(instruction);
			const embeddable =
				instruction.type === "call" ||
				instruction.type === "callKnown" ||
				instruction.type === "construct";
			for (let position = 0; position < count; position++) {
				const register = registers![position]!;
				if (register === -1) {
					if (!embeddable || position < shape.writes) {
						failAtInstruction(
							"only a call-like operand may drop its register",
							functionIndex,
							block,
							index,
							opcode,
						);
					}
					if (immediates?.[position] === undefined) {
						failAtInstruction(
							"dropped register operand has no embedded immediate value",
							functionIndex,
							block,
							index,
							opcode,
						);
					}
					continue;
				}
				if (
					!Number.isSafeInteger(register) ||
					register < 0 ||
					register >= fn.registerCount
				) {
					failAtInstruction(
						`register operand is out of bounds for a ${fn.registerCount}-register function`,
						functionIndex,
						block,
						index,
						opcode,
						register,
					);
				}
				if (immediates?.[position] !== undefined) {
					failAtInstruction(
						"embedded immediate value must replace its register operand",
						functionIndex,
						block,
						index,
						opcode,
						register,
					);
				}
			}
			if (immediates !== undefined && immediates.length > count) {
				failAtInstruction(
					"embedded immediate values exceed the register operands",
					functionIndex,
					block,
					index,
					opcode,
				);
			}
			const blocks = instructionBlocks(instruction);
			if ((blocks?.length ?? 0) !== shape.blocks) {
				failAtInstruction(
					`instruction takes ${blocks?.length ?? 0} block operands, expected ${shape.blocks}`,
					functionIndex,
					block,
					index,
					opcode,
				);
			}
			for (const target of blocks ?? []) {
				if (!Number.isSafeInteger(target) || target < 0 || target >= fn.blocks.length) {
					failAtInstruction(
						`block operand names unknown block ${target} in a ${fn.blocks.length}-block function`,
						functionIndex,
						block,
						index,
						opcode,
					);
				}
			}
			const twoAddress = COMPILER_TWO_ADDRESS_OPERANDS[instruction.type];
			if (
				twoAddress !== undefined &&
				registers?.[twoAddress.result] !== registers?.[twoAddress.operand]
			) {
				failAtInstruction(
					`two-address instruction must use ${twoAddress.requirement}`,
					functionIndex,
					block,
					index,
					opcode,
					registers?.[twoAddress.result],
				);
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
					!numericWidening &&
					!unreachableMoves?.has(instruction)
				) {
					failAtInstruction(
						"move must not narrow its source register class",
						functionIndex,
						block,
						index,
						opcode,
						destination,
					);
				}
				if (instruction.exactScalarAfterTdz !== undefined && !provenNarrowing) {
					failAtInstruction(
						"post-TDZ scalar move carries an invalid narrowing proof",
						functionIndex,
						block,
						index,
						opcode,
						destination,
					);
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
	for (let block = 0; block < fn.blocks.length; block++) {
		const { instructions } = fn.blocks[block]!;
		const context: ExecutionVerificationContext = { functionIndex, block };
		let begins = 0;
		let ends = 0;
		let catches = 0;
		let lastTransferOperand = instructions.length - 1;
		while (
			lastTransferOperand >= 0 &&
			(instructions[lastTransferOperand]!.type === "sourcePos" ||
				instructions[lastTransferOperand]!.type === "tryEnd")
		)
			lastTransferOperand--;
		for (let index = 0; index < instructions.length; index++) {
			const instruction = instructions[index]!;
			if (
				(instruction.type === "jump" || instruction.type === "jumpIf") &&
				model.handlerTargets.has(instruction.blocks[0])
			) {
				failAtInstruction(
					"ordinary control flow may not target an exception-handler block",
					functionIndex,
					block,
					index,
					instruction.type,
				);
			}
			if (BLOCK_TERMINATORS.has(instruction.type) && index < lastTransferOperand) {
				failAtInstruction(
					"unconditional control transfer must end its containing block",
					functionIndex,
					block,
					index,
					instruction.type,
				);
			}
			if (instruction.type === "tryBegin") {
				begins++;
				if (index !== 0) {
					failAtInstruction(
						"protected range must open at the start of its block",
						functionIndex,
						block,
						index,
						instruction.type,
					);
				}
				if (instruction.blocks[1] !== block) {
					failAtInstruction(
						"tryBegin must name its own protected block",
						functionIndex,
						block,
						index,
						instruction.type,
					);
				}
				if (instruction.blocks[0] === block) {
					failAtInstruction(
						"protected block cannot be its own exception handler",
						functionIndex,
						block,
						index,
						instruction.type,
					);
				}
			}
			if (instruction.type === "tryEnd") {
				ends++;
				if (index !== instructions.length - 1) {
					failAtInstruction(
						"protected range must close at the end of its block",
						functionIndex,
						block,
						index,
						instruction.type,
					);
				}
			}
			if (instruction.type === "catch") {
				catches++;
				if (!model.handlerTargets.has(block)) {
					failAtInstruction(
						"catch may only appear in an exception-handler block",
						functionIndex,
						block,
						index,
						instruction.type,
					);
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
	unreachable: boolean,
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
			!isBoxed(fn, destination) &&
			!unreachable
		) {
			fail("parallel copy must not narrow a source register class", {
				...context,
				register: destination,
			});
		}
	}
	const held = new Map<number, number>();
	const definedTemporaries = new Set<number>();
	for (const temporary of copy.temporaries) {
		if (
			copy.assignments.some(
				({ destination, source }) => destination === temporary || source === temporary,
			)
		) {
			fail("parallel-copy temporary must not be a semantic operand", {
				...context,
				register: temporary,
			});
		}
	}
	const entryValue = (register: number): number => held.get(register) ?? register;
	for (const move of copy.moves) {
		if (!model.sites.has(move)) {
			fail("declared parallel-copy move is not present in this function", context);
		}
		if (
			copy.temporaries.includes(move.registers[1]) &&
			!definedTemporaries.has(move.registers[1])
		) {
			fail("parallel-copy temporary is read before its definition in this copy", {
				...context,
				register: move.registers[1],
			});
		}
		held.set(move.registers[0], entryValue(move.registers[1]));
		if (copy.temporaries.includes(move.registers[0]))
			definedTemporaries.add(move.registers[0]);
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

function verifyParallelCopies(
	model: FunctionModel,
	unreachableMoves?: ReadonlySet<CompilerInstruction>,
): void {
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
		const firstBlock = model.siteBlocks[firstSite]!;
		const firstIndex = firstSite - model.blockStarts[firstBlock]!;
		const context: ExecutionVerificationContext = {
			functionIndex,
			block: firstBlock,
			instruction: firstIndex,
			opcode: copy.kind,
		};
		for (const [offset, move] of copy.moves.entries()) {
			const site = model.sites.get(move);
			if (
				site === undefined ||
				model.siteBlocks[site] !== firstBlock ||
				site !== firstSite + offset
			) {
				fail("parallel-copy moves must run contiguously inside one block", context);
			}
			if (claimed.has(move)) {
				fail("move belongs to more than one parallel copy", context);
			}
			claimed.add(move);
		}
		if (copy.kind === "handler-input") {
			const opening = fn.blocks[firstBlock]!.instructions[0];
			if (opening?.type !== "tryBegin" || firstIndex !== 1) {
				fail(
					"handler-input copy must follow the tryBegin of its protected block",
					context,
				);
			}
		}
		simulateParallelCopy(
			model,
			copy,
			context,
			copy.moves.every((move) => unreachableMoves?.has(move) === true),
		);
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
		if (site !== undefined) handlerInputCopies.set(model.siteBlocks[site]!, copy);
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

function verifyTemporaryRegisters(model: FunctionModel, native: boolean): void {
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
	const reusable = new Set(
		native ? fn.parallelCopies.flatMap((copy) => copy.temporaries) : [],
	);
	const copyByMove = new Map<CompilerInstruction, ExecutionParallelCopy>(
		fn.parallelCopies.flatMap((copy) => copy.moves.map((move) => [move, copy] as const)),
	);
	const owner = new Map<number, number>();
	for (const [block, { instructions }] of fn.blocks.entries()) {
		const defined = new Set<number>();
		for (const [index, instruction] of instructions.entries()) {
			const shape = executionOperandShape(instruction.type);
			if (shape === undefined || shape === "variable-outputs")
				throw new Error("Expected a verified instruction shape");
			const registers = instructionRegisters(instruction);
			for (const register of registers ?? []) {
				if (
					reusable.has(register) &&
					!copyByMove.get(instruction)?.temporaries.includes(register)
				)
					failAtInstruction(
						"native copy scratch escapes its declared parallel copy",
						functionIndex,
						block,
						index,
						instruction.type,
						register,
					);
			}
			for (let position = shape.writes; position < (registers?.length ?? 0); position++) {
				const register = registers![position]!;
				if (seen.has(register) && !defined.has(register))
					failAtInstruction(
						"temporary register is read before its definition",
						functionIndex,
						block,
						index,
						instruction.type,
						register,
					);
			}
			for (let position = 0; position < shape.writes; position++) {
				const register = registers![position]!;
				if (!seen.has(register)) continue;
				const existing = owner.get(register);
				if (existing !== undefined && existing !== block && !reusable.has(register))
					failAtInstruction(
						"temporary register is defined in more than one block",
						functionIndex,
						block,
						index,
						instruction.type,
						register,
					);
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

const CORE_OPERATION = 1;
const CORE_SAFEPOINT = 2;
const CORE_ORIGIN_RECORDED = 4;
const CORE_SAFEPOINT_COVERED = 8;

const ROOT_BOUNDARIES = [
	"rootRegisters",
	"incomingRootRegisters",
	"outgoingRootRegisters",
] as const;

function firstRootMismatch(
	actual: ReadonlyArray<number>,
	words: number | ArrayLike<number>,
): number | null | undefined {
	let index = 0;
	const singleWord = typeof words === "number";
	const count = singleWord ? 1 : words.length;
	for (let word = 0; word < count; word++) {
		let bits = singleWord ? words : words[word]!;
		while (bits !== 0) {
			const register = word * 32 + 31 - Math.clz32(bits & -bits);
			if (actual[index++] !== register) return register;
			bits &= bits - 1;
		}
	}
	return index === actual.length ? undefined : (actual[index] ?? null);
}

function verifyGcRoots(
	model: FunctionModel,
	core: CoreFunctionStore,
	loopBackedgeInstructions: typeof executionLoopBackedgeInstructions,
	entry?: {
		readonly suppliedArguments: number | undefined;
		readonly discharged: ReadonlyArray<CoreTargetDischargedSafepoint>;
	},
): void {
	const { fn, functionIndex } = model;
	const reachable = new Set(fn.coreBlocks);
	const expected: Array<CoreInstructionId> = [];
	const coreFlags = new Uint8Array(core.instructionCapacity);
	for (const instruction of core.instructionIds()) {
		if (core.instructionKind(instruction) !== "operation") continue;
		coreFlags[instruction] = CORE_OPERATION;
		if (
			reachable.has(core.instructionBlock(instruction)) &&
			coreInstructionNeedsOperationSafepoint(core, instruction)
		) {
			coreFlags[instruction] |= CORE_SAFEPOINT;
			expected.push(instruction);
		}
	}
	const safepoints = new Map<CompilerInstruction, number>();
	const expectedBackedges = loopBackedgeInstructions(fn);
	const recordedBackedges = new Set<CompilerInstruction>();
	const rootStamps = new Uint32Array(fn.registerCount);
	let rootStamp = 0;
	for (const safepoint of fn.gc.safepoints) {
		const { instruction, rootRegisters } = safepoint;
		const site = model.sites.get(instruction);
		if (site === undefined) {
			fail("recorded safepoint does not belong to this function", { functionIndex });
		}
		if (safepoints.has(instruction)) {
			failAtSite(
				"instruction has two target safepoint records",
				model,
				instruction,
				site,
			);
		}
		safepoints.set(instruction, rootStamp);
		rootStamp++;
		for (const register of rootRegisters) {
			if (
				!Number.isSafeInteger(register) ||
				register < 0 ||
				register >= fn.registerCount
			) {
				failAtSite(
					`GC root register is out of bounds for a ${fn.registerCount}-register function`,
					model,
					instruction,
					site,
					register,
				);
			}
			if (!isRooted(fn, register)) {
				failAtSite(
					"GC root register must carry a traced value",
					model,
					instruction,
					site,
					register,
				);
			}
			if (rootStamps[register] === rootStamp)
				failAtSite(
					"GC root register is listed twice",
					model,
					instruction,
					site,
					register,
				);
			rootStamps[register] = rootStamp;
		}
		if (safepoint.kind === "loop-backedge") {
			if (!expectedBackedges.has(instruction)) {
				failAtSite(
					"loop-backedge safepoint does not name a native polling edge",
					model,
					instruction,
					site,
				);
			}
			recordedBackedges.add(instruction);
			continue;
		}
		if (safepoint.kind === "closure-materialization") {
			if (
				instruction.type !== "loadCaptured" ||
				instruction.materializeClosure === undefined
			) {
				failAtSite(
					"closure-materialization safepoint does not name a materializing captured load",
					model,
					instruction,
					site,
				);
			}
			continue;
		}
		if (safepoint.kind !== "operation") {
			fail("target safepoint has an unknown kind", { functionIndex });
		}
		const { coreInstruction, realizedCoreInstructions } = safepoint;
		const originFlags =
			typeof coreInstruction === "number" ? (coreFlags[coreInstruction] ?? 0) : 0;
		if ((originFlags & CORE_ORIGIN_RECORDED) !== 0) {
			fail(`Core instruction @${coreInstruction} has two target safepoint records`, {
				functionIndex,
			});
		}
		if ((originFlags & CORE_OPERATION) === 0) {
			fail(`target safepoint names unknown Core instruction @${coreInstruction}`, {
				functionIndex,
			});
		}
		coreFlags[coreInstruction] = originFlags | CORE_ORIGIN_RECORDED;
		const originOpcode = core.instructionOpcodeName(coreInstruction);
		const attributes = core.instructionAttributes(coreInstruction);
		const block = model.siteBlocks[site]!;
		const index = site - model.blockStarts[block]!;
		const instructions = fn.blocks[block]!.instructions;
		const callee = instructions[index - 1];
		const foreignCallee = instructions[index - 2];
		const staticForeignCall =
			originOpcode === "callForeign" &&
			instruction.type === "call" &&
			instruction.foreignCall !== undefined &&
			foreignCallee?.type === "loadGlobal" &&
			foreignCallee.index === attributes.foreignSlot &&
			foreignCallee.registers[0] === instruction.registers[1] &&
			foreignCallee.registers[0] >= fn.allocatedRegisterCount &&
			callee?.type === "createUndefined" &&
			callee.registers[0] === instruction.registers[2] &&
			callee.registers[0] >= fn.allocatedRegisterCount;
		const known =
			typeof attributes.operation === "string"
				? knownOperations()[knownOperationIndex(attributes.operation) ?? -1]
				: undefined;
		const exactCallbackCall =
			originOpcode === "callKnown" &&
			instruction.type === "call" &&
			!attributes.construct &&
			attributes.argumentMode === undefined &&
			instruction.directCallbackFunctionIndex !== undefined &&
			coreDirectBuiltinCallbackTarget(core, coreInstruction) !== undefined &&
			instruction.knownBuiltinCall?.operation === attributes.operation &&
			callee?.type === "loadPrimordial" &&
			known !== undefined &&
			callee.nodeIndex === known.node &&
			callee.registers[0] === instruction.registers[1] &&
			callee.registers[0] >= fn.allocatedRegisterCount;
		if (
			(exactCallbackCall || staticForeignCall) &&
			instruction.registers.length !==
				core.kernel.instructionResultCount(coreInstruction) +
					core.kernel.instructionOperandCount(coreInstruction) +
					(staticForeignCall ? 2 : 1)
		) {
			fail("call bridge changed its argument count", { functionIndex });
		}
		if (instruction.type !== originOpcode && !exactCallbackCall && !staticForeignCall) {
			fail(
				`Core instruction @${coreInstruction} lowered to ${instruction.type}, expected ${originOpcode}`,
				{ functionIndex },
			);
		}
		const immediates = instructionImmediates(instruction);
		let embeddedSafepoints: Set<number> | undefined;
		const kernel = core.kernel;
		const originInputStart = kernel.instructionOperandStart(coreInstruction);
		const originInputCount = kernel.instructionOperandCount(coreInstruction);
		const originOutputCount = kernel.instructionResultCount(coreInstruction);
		for (let index = 0; index < originInputCount; index++) {
			if (
				immediates?.[
					originOutputCount + (staticForeignCall ? 2 : exactCallbackCall ? 1 : 0) + index
				] === undefined
			)
				continue;
			const input = kernel.operandAt(originInputStart + index);
			if (kernel.valueDefinitionKind(input) === 1) {
				(embeddedSafepoints ??= new Set()).add(kernel.valueDefinitionOwner(input));
			}
		}
		if (realizedCoreInstructions.length === 0) {
			fail("target safepoint realizes no Core collection point", { functionIndex });
		}
		for (const realized of realizedCoreInstructions) {
			if (typeof realized !== "number" || (coreFlags[realized]! & CORE_SAFEPOINT) === 0) {
				fail(`recorded Core instruction @${realized} is not a safepoint`, {
					functionIndex,
				});
			}
			if (realized !== coreInstruction && !embeddedSafepoints?.has(realized)) {
				fail(
					`Core safepoint @${realized} is neither the target origin nor an embedded input`,
					{ functionIndex },
				);
			}
			coreFlags[realized]! |= CORE_SAFEPOINT_COVERED;
		}
	}
	for (const [instruction, site] of model.sites)
		if (
			instruction.type === "loadCaptured" &&
			instruction.materializeClosure !== undefined &&
			!safepoints.has(instruction)
		)
			failAtSite(
				"materializing captured load has no safepoint record",
				model,
				instruction,
				site,
			);
	for (const { coreInstruction, instruction, reason } of entry?.discharged ?? []) {
		const site = model.sites.get(instruction);
		if (
			reason !== "entry-argument" ||
			site === undefined ||
			typeof coreInstruction !== "number" ||
			(coreFlags[coreInstruction]! & (CORE_SAFEPOINT | CORE_SAFEPOINT_COVERED)) !==
				CORE_SAFEPOINT ||
			core.instructionOpcodeName(coreInstruction) !== instruction.type ||
			entry?.suppliedArguments === undefined ||
			!entrySuppliedArgumentRead(instruction, entry.suppliedArguments)
		)
			fail(`Core safepoint @${coreInstruction} has no valid discharge`, {
				functionIndex,
			});
		coreFlags[coreInstruction]! |= CORE_SAFEPOINT_COVERED;
	}
	const missing = expected.find(
		(instruction) => (coreFlags[instruction]! & CORE_SAFEPOINT_COVERED) === 0,
	);
	if (missing !== undefined) {
		fail(`Core safepoint @${missing} has no target safepoint record`, { functionIndex });
	}
	for (const instruction of expectedBackedges) {
		if (!recordedBackedges.has(instruction)) {
			failAtSite(
				"native polling edge has no loop-backedge safepoint record",
				model,
				instruction,
				model.sites.get(instruction)!,
			);
		}
	}
	let mismatch:
		| {
				ordinal: number;
				boundary: keyof ExecutionSafepointRoots;
				register: number | null;
		  }
		| undefined;
	// Walks visit blocks in liveness order. Report errors in published safepoint order.
	visitExecutionSafepointRoots(fn, safepoints, (instruction, boundary, words) => {
		const ordinal = safepoints.get(instruction)!;
		const actual = fn.gc.safepoints[ordinal]![boundary];
		const register = firstRootMismatch(actual, words);
		if (register === undefined) return;
		if (
			mismatch === undefined ||
			ordinal < mismatch.ordinal ||
			(ordinal === mismatch.ordinal &&
				ROOT_BOUNDARIES.indexOf(boundary) < ROOT_BOUNDARIES.indexOf(mismatch.boundary))
		) {
			mismatch = { ordinal, boundary, register };
		}
	});
	if (mismatch !== undefined) {
		const instruction = fn.gc.safepoints[mismatch.ordinal]!.instruction;
		const phase = mismatch.boundary === "rootRegisters" ? "" : ` (${mismatch.boundary})`;
		failAtSite(
			`GC safepoint roots do not match exact execution liveness${phase}`,
			model,
			instruction,
			model.sites.get(instruction)!,
			mismatch.register ?? undefined,
		);
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
					block: model.siteBlocks[site]!,
					instruction: site - model.blockStarts[model.siteBlocks[site]!]!,
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
	loopBackedgeInstructions = executionLoopBackedgeInstructions,
	entry?: Parameters<typeof verifyGcRoots>[3],
	unreachableMoves?: ReadonlySet<CompilerInstruction>,
): void {
	const model = buildFunctionModel(fn, functionIndex);
	verifyInstructionOperands(model, unreachableMoves);
	verifyParallelCopies(model, unreachableMoves);
	verifyGcRoots(model, core, loopBackedgeInstructions, entry);
}

export function verifyExecutionProgram(
	program: ExecutionProgram,
	loopBackedgeInstructions?: typeof executionLoopBackedgeInstructions,
): void {
	const pollingEdges =
		loopBackedgeInstructions ??
		("kind" in program && program.kind === "native"
			? nativeLoopBackedgeInstructions
			: executionLoopBackedgeInstructions);
	verifyProgramCardinality(program);
	for (let index = 0; index < program.functions.length; index++) {
		const model = buildFunctionModel(program.functions[index]!, index);
		verifyRegisterPlan(model);
		verifyInstructionOperands(model);
		verifyBlockStructure(model);
		verifyParallelCopies(model);
		verifyExceptionEntries(model);
		verifyTemporaryRegisters(model, "kind" in program && program.kind === "native");
		const coreFunction = program.functionMap.executionToCore[index];
		if (coreFunction === undefined) {
			fail("target function has no Core function identity", { functionIndex: index });
		}
		verifyGcRoots(model, program.core.function(coreFunction), pollingEdges);
		verifyRegions(model);
	}
}
