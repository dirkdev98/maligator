import type { CoreOpcode } from "./core-ir-opcodes.ts";
import type { IRInstruction } from "./ir.ts";

/**
 * Temporary legacy spellings for concepts represented structurally in Core IR.
 * Keeping this list explicit makes the Core/legacy opcode boundary exhaustive
 * while the frontend and backend are being retargeted.
 */
export const IR_STRUCTURAL_INSTRUCTION_TYPES = [
	"catch",
	"jump",
	"jumpIf",
	"return",
	"sourcePos",
	"throw",
	"tryBegin",
	"tryEnd",
] as const;

export type IrStructuralInstructionType =
	(typeof IR_STRUCTURAL_INSTRUCTION_TYPES)[number];

const structuralTypes: ReadonlySet<string> = new Set(IR_STRUCTURAL_INSTRUCTION_TYPES);

export function isIrStructuralInstructionType(
	type: string,
): type is IrStructuralInstructionType {
	return structuralTypes.has(type);
}

type IrInstructionType = IRInstruction["type"];
type MissingFromCoreBoundary = Exclude<
	IrInstructionType,
	CoreOpcode | IrStructuralInstructionType
>;
type CoreOpcodeMissingFromLegacy = Exclude<CoreOpcode, IrInstructionType>;

/** Compile-time proof that every legacy instruction has exactly one ownership side. */
export const IR_OPCODE_UNIVERSES_ARE_EXHAUSTIVE: [
	MissingFromCoreBoundary,
	CoreOpcodeMissingFromLegacy,
] extends [never, never]
	? true
	: never = true;
