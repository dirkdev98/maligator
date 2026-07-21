import type { IRFunction, IRInstruction } from "./ir.ts";

/** Instructions for which every register operand is a use. */
const NO_DESTINATION = new Set<IRInstruction["type"]>([
	"return",
	"throw",
	"jump",
	"jumpIf",
	"storeLocal",
	"storeGlobal",
	"storeCaptured",
	"storeGlobalProperty",
	"storeProperty",
	"storePropertyStatic",
	"storeSuperProperty",
	"mergeDataProperties",
	"defineAccessor",
	"defineProperty",
	"definePrivate",
	"initPrivateFields",
	"storePrivate",
	"setPrototype",
	"setFunctionName",
	"iteratorClose",
	"withEnter",
	"withExit",
	"checkSuperClass",
	"requireCoercible",
	"throwIfTdz",
]);

/** Instructions with two leading destination operands. */
const TWO_DESTINATIONS = new Set<IRInstruction["type"]>([
	"getIterator",
	"getAsyncIterator",
	"iteratorStep",
	"yield",
	"await",
]);

/** Number of leading register operands defined by an instruction. */
export function destinationCount(instruction: IRInstruction): number {
	if (!("registers" in instruction) || NO_DESTINATION.has(instruction.type)) {
		return 0;
	}
	return TWO_DESTINATIONS.has(instruction.type) ? 2 : 1;
}

export interface IRInstructionLocation {
	readonly blockIndex: number;
	readonly instructionIndex: number;
}

export interface IRRegisterOperand {
	readonly instruction: IRInstruction;
	readonly position: number;
}

export interface IRRegisterIndex {
	/** All non-sentinel definitions, including every destination position. */
	readonly definitions: ReadonlyMap<number, ReadonlyArray<IRRegisterOperand>>;
	/** Registers with exactly one defining operand, mapped to its instruction. */
	readonly uniqueDefinitions: ReadonlyMap<number, IRInstruction>;
	/** All non-sentinel uses and their positions. */
	readonly uses: ReadonlyMap<number, ReadonlyArray<IRRegisterOperand>>;
	/** Present only when `locations: true` was requested. */
	readonly locations?: ReadonlyMap<IRInstruction, IRInstructionLocation>;
}

export interface IRRegisterIndexOptions {
	readonly locations?: boolean;
}

/**
 * Build an immutable snapshot of a function's register definitions and uses.
 * Rebuild it after changing instruction operands or block contents.
 */
export function buildIRRegisterIndex(
	fn: IRFunction,
	options: IRRegisterIndexOptions = {},
): IRRegisterIndex {
	const definitions = new Map<number, Array<IRRegisterOperand>>();
	const uses = new Map<number, Array<IRRegisterOperand>>();
	const locations = options.locations
		? new Map<IRInstruction, IRInstructionLocation>()
		: undefined;

	for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
		const block = fn.blocks[blockIndex]!;
		for (
			let instructionIndex = 0;
			instructionIndex < block.instructions.length;
			instructionIndex++
		) {
			const instruction = block.instructions[instructionIndex]!;
			if (locations) {
				locations.set(instruction, Object.freeze({ blockIndex, instructionIndex }));
			}
			if (!("registers" in instruction)) continue;

			const destinations = destinationCount(instruction);
			for (let position = 0; position < instruction.registers.length; position++) {
				const register = instruction.registers[position]!;
				if (register < 0) continue;
				const index = position < destinations ? definitions : uses;
				const operands = index.get(register) ?? [];
				operands.push(Object.freeze({ instruction, position }));
				index.set(register, operands);
			}
		}
	}

	const uniqueDefinitions = new Map<number, IRInstruction>();
	for (const [register, operands] of definitions) {
		Object.freeze(operands);
		if (operands.length === 1) {
			uniqueDefinitions.set(register, operands[0]!.instruction);
		}
	}
	for (const operands of uses.values()) Object.freeze(operands);

	return Object.freeze({
		definitions,
		uniqueDefinitions,
		uses,
		...(locations ? { locations } : {}),
	});
}
