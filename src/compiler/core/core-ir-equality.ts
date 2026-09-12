import type { CoreAttributeValue, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export function coreAttributeValuesEqual(
	left: CoreAttributeValue,
	right: CoreAttributeValue,
): boolean {
	if (Object.is(left, right)) return true;
	if (
		left === null ||
		right === null ||
		typeof left !== "object" ||
		typeof right !== "object"
	)
		return false;
	if (Array.isArray(left)) {
		if (!Array.isArray(right)) return false;
		const leftArray = left as ReadonlyArray<CoreAttributeValue>;
		const rightArray = right as ReadonlyArray<CoreAttributeValue>;
		return (
			leftArray.length === rightArray.length &&
			leftArray.every((value, index) =>
				coreAttributeValuesEqual(value, rightArray[index]),
			)
		);
	}
	if (Array.isArray(right)) return false;
	const leftObject = left as Readonly<Record<string, CoreAttributeValue>>;
	const rightObject = right as Readonly<Record<string, CoreAttributeValue>>;
	const leftKeys = Object.keys(leftObject);
	const rightKeys = Object.keys(rightObject);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.prototype.hasOwnProperty.call(rightObject, key) &&
				coreAttributeValuesEqual(leftObject[key], rightObject[key]),
		)
	);
}

export function coreInstructionInputsEqual(
	fn: CoreFunctionStore,
	left: CoreInstructionId,
	right: CoreInstructionId,
	leftInputs?: ReadonlyArray<CoreValueId>,
	rightInputs?: ReadonlyArray<CoreValueId>,
): boolean {
	if (fn.instructionOpcode(left) !== fn.instructionOpcode(right)) return false;
	const leftStart = fn.kernel.instructionOperandStart(left);
	const rightStart = fn.kernel.instructionOperandStart(right);
	const leftCount = leftInputs?.length ?? fn.kernel.instructionOperandCount(left);
	const rightCount = rightInputs?.length ?? fn.kernel.instructionOperandCount(right);
	if (leftCount !== rightCount) return false;
	for (let index = 0; index < leftCount; index++) {
		const leftValue = leftInputs?.[index] ?? fn.kernel.operandAt(leftStart + index);
		const rightValue = rightInputs?.[index] ?? fn.kernel.operandAt(rightStart + index);
		if (leftValue !== rightValue) return false;
	}
	return coreAttributeValuesEqual(
		fn.instructionAttributes(left),
		fn.instructionAttributes(right),
	);
}
