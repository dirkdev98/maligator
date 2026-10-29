import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

/** The runtime's MAL_SHAPE_MAX_INLINE_SLOTS: a shaped slot index fits in a u8. */
export const CORE_MAX_SHAPED_OBJECT_SLOTS = 255;

function rootDefinition(
	fn: CoreFunctionStore,
	input: CoreValueId,
): CoreInstructionId | undefined {
	const seen = new Set<CoreValueId>();
	let value = input;
	while (!seen.has(value) && fn.kernel.valueDefinitionKind(value) === 1) {
		seen.add(value);
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(definition) !== "move") return definition;
		if (fn.kernel.instructionOperandCount(definition) !== 1) return undefined;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition));
	}
	return undefined;
}

/** Capacity only: these properties are not considered present until their stores execute. */
export function coreConstructorSlotReserve(fn: CoreFunctionStore): number {
	if (!fn.metadata.isClassConstructor || fn.metadata.isDerivedConstructor) return 0;
	const keys = new Set<number>();
	// Private elements share the instance's shape slots; each install names a distinct element.
	let privateElements = 0;
	for (const instruction of fn.instructionIds()) {
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		if (
			opcode !== "storePropertyStatic" &&
			opcode !== "defineProperty" &&
			opcode !== "definePrivate" &&
			opcode !== "initPrivateFields"
		)
			continue;
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const receiver = fn.kernel.operandAt(operandStart);
		const receiverDefinition = rootDefinition(fn, receiver);
		if (
			receiverDefinition === undefined ||
			fn.instructionOpcodeName(receiverDefinition) !== "loadThis"
		)
			continue;
		if (opcode === "definePrivate") {
			privateElements++;
			continue;
		}
		if (opcode === "initPrivateFields") {
			privateElements += fn.kernel.instructionOperandCount(instruction) - 1;
			continue;
		}
		if (opcode === "storePropertyStatic") {
			const stringIndex = fn.instructionAttributes(instruction).stringIndex;
			if (typeof stringIndex === "number") keys.add(stringIndex);
			continue;
		}
		const key = fn.kernel.operandAt(operandStart + 1);
		const definition = rootDefinition(fn, key);
		if (
			definition === undefined ||
			fn.instructionOpcodeName(definition) !== "createString"
		)
			continue;
		const stringIndex = fn.instructionAttributes(definition).stringIndex;
		if (typeof stringIndex === "number") keys.add(stringIndex);
	}
	return Math.min(keys.size + privateElements, CORE_MAX_SHAPED_OBJECT_SLOTS);
}
