import type { CoreCompilation } from "../core/core-compilation.ts";
import { analyzeCoreValueClasses } from "../core/core-ir-value-classes.ts";
import { coreInstructionId } from "../core/core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "../core/core-ir.ts";
import { corePrivateFieldFacts } from "../core/core-private-field-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "../core/core-store.ts";

export type CoreExactArrayAccess = "element" | "length";

const NO_ACCESSES: ReadonlyMap<CoreInstructionId, CoreExactArrayAccess> = new Map();

function isArrayIntrinsic(fn: CoreFunctionStore, value: CoreValueId): boolean {
	const definition = valueDefinition(fn, value);
	return (
		definition !== undefined &&
		fn.instructionOpcodeName(definition) === "loadIntrinsic" &&
		fn.instructionAttributes(definition).intrinsic === "Array"
	);
}

function valueDefinition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

// The class analysis brands only these producers, or joins of them.
function mayBeExactArray(
	program: CoreProgram,
	fn: CoreFunctionStore,
	parameters: ReadonlySet<CoreValueId>,
	value: CoreValueId,
): boolean {
	const definition = valueDefinition(fn, value);
	if (definition === undefined) return !parameters.has(value);
	const operand = (index: number) =>
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition) + index);
	switch (fn.instructionOpcodeName(definition)) {
		case "createArray":
			return true;
		case "loadPrivate":
			return corePrivateFieldFacts(program)?.field(fn, operand(1))?.brand === "Array";
		case "callKnown": {
			const { construct, operation } = fn.instructionAttributes(definition);
			return operation === "Array.from" || (operation === "Array" && construct === true);
		}
		case "call":
			return (
				fn.kernel.instructionOperandCount(definition) > 1 &&
				isArrayIntrinsic(fn, operand(1))
			);
		case "construct":
			return isArrayIntrinsic(fn, operand(0));
		default:
			return false;
	}
}

function isLengthString(program: CoreProgram, index: number): boolean {
	const units = program.stringConstants[index];
	return units !== undefined && String.fromCharCode(...units) === "length";
}

/**
 * Element accesses and length reads whose receiver is always an Array exotic
 * object, so native code can skip the receiver's class test. This is a lowering
 * choice on finished Core: the accesses keep their Core semantics and effects.
 */
export function planCoreExactArrayAccesses(
	compilation: CoreCompilation,
	functionId: CoreFunctionId,
): ReadonlyMap<CoreInstructionId, CoreExactArrayAccess> {
	const program = compilation.program;
	const fn = program.function(functionId);
	const candidates: Array<readonly [CoreInstructionId, CoreExactArrayAccess]> = [];
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const opcode = fn.instructionOpcodeName(instruction);
		const stringIndex = fn.instructionAttributes(instruction).stringIndex;
		if (opcode === "loadProperty" || opcode === "storeProperty")
			candidates.push([instruction, "element"]);
		else if (
			opcode === "loadPropertyStatic" &&
			typeof stringIndex === "number" &&
			isLengthString(program, stringIndex)
		)
			candidates.push([instruction, "length"]);
	}
	const parameters = new Set(
		Array.from({ length: fn.parameterCount }, (_, index) =>
			fn.kernel.functionParameter(index),
		),
	);
	if (
		!candidates.some(([instruction]) =>
			mayBeExactArray(
				program,
				fn,
				parameters,
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
			),
		)
	)
		return NO_ACCESSES;
	const classes = analyzeCoreValueClasses(program, functionId, compilation.context);
	const accesses = new Map<CoreInstructionId, CoreExactArrayAccess>();
	for (const [instruction, access] of candidates) {
		const receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		if (
			fn.valueRepresentation(receiver) === "boxed" &&
			classes.exactHeapBrand(receiver, instruction) === "Array"
		)
			accesses.set(instruction, access);
	}
	return accesses;
}
