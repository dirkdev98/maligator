import { CORE_OPCODES, coreOpcodeRegistry } from "../core/core-ir-opcodes.ts";

interface ExecutionOperandShape {
	readonly writes: number;
	readonly minimumRegisters: number;
	readonly maximumRegisters: number;
	readonly blocks: number;
}

// Structural instructions have no Core opcode. The other shapes come from the
// same descriptors used to verify Core, including variable input arities.
const structuralShapes = new Map<string, ExecutionOperandShape>([
	["sourcePos", { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 0 }],
	["jump", { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 1 }],
	["jumpIf", { writes: 0, minimumRegisters: 1, maximumRegisters: 1, blocks: 1 }],
	["tryBegin", { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 2 }],
	["tryEnd", { writes: 0, minimumRegisters: 0, maximumRegisters: 0, blocks: 0 }],
	["catch", { writes: 1, minimumRegisters: 1, maximumRegisters: 1, blocks: 0 }],
	["return", { writes: 0, minimumRegisters: 1, maximumRegisters: 1, blocks: 0 }],
	["throw", { writes: 0, minimumRegisters: 1, maximumRegisters: 1, blocks: 0 }],
]);

let shapes: ReadonlyMap<string, ExecutionOperandShape | "variable-outputs"> | undefined;

function executionOperandShapes(): ReadonlyMap<
	string,
	ExecutionOperandShape | "variable-outputs"
> {
	const result = new Map<string, ExecutionOperandShape | "variable-outputs">(
		structuralShapes,
	);
	for (const opcode of CORE_OPCODES) {
		const { inputs, outputs } = coreOpcodeRegistry.require(opcode);
		const writes = outputs.minimum;
		result.set(
			opcode,
			writes !== outputs.maximum
				? "variable-outputs"
				: {
						writes,
						minimumRegisters: writes + inputs.minimum,
						maximumRegisters: writes + inputs.maximum,
						blocks: 0,
					},
		);
	}
	return result;
}

export function executionOperandShape(
	type: string,
): ExecutionOperandShape | "variable-outputs" | undefined {
	return (shapes ??= executionOperandShapes()).get(type);
}
