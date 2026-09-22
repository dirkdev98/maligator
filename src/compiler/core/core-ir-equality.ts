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

const NUMBER_HASH_VIEW = new DataView(new ArrayBuffer(8));

function mixHash(hash: number, value: number): number {
	return Math.imul(hash ^ value, 0x0100_0193) >>> 0;
}
function hashString(hash: number, value: string): number {
	let result = mixHash(hash, value.length);
	for (let index = 0; index < value.length; index++)
		result = mixHash(result, value.charCodeAt(index));
	return result;
}
function isAttributeArray(
	value: CoreAttributeValue,
): value is ReadonlyArray<CoreAttributeValue> {
	return Array.isArray(value);
}

export function coreAttributeValueHash(hash: number, value: CoreAttributeValue): number {
	if (value === undefined) return mixHash(hash, 1);
	if (value === null) return mixHash(hash, 2);
	if (typeof value === "boolean") return mixHash(hash, value ? 4 : 3);
	if (typeof value === "number") {
		if (Number.isNaN(value)) return mixHash(hash, 9);
		NUMBER_HASH_VIEW.setFloat64(0, value);
		return mixHash(
			mixHash(mixHash(hash, 5), NUMBER_HASH_VIEW.getUint32(0)),
			NUMBER_HASH_VIEW.getUint32(4),
		);
	}
	if (typeof value === "string") return hashString(mixHash(hash, 6), value);
	if (isAttributeArray(value)) {
		let result = mixHash(mixHash(hash, 7), value.length);
		for (const entry of value) result = coreAttributeValueHash(result, entry);
		return result;
	}
	const object = value;
	const keys = Object.keys(object).sort();
	let result = mixHash(mixHash(hash, 8), keys.length);
	for (const key of keys) {
		result = coreAttributeValueHash(hashString(result, key), object[key]);
	}
	return result;
}

export function coreInstructionInputsHash(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): number {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	let hash = mixHash(2_166_136_261, fn.instructionOpcode(instruction));
	for (let index = 0; index < count; index++)
		hash = mixHash(hash, fn.kernel.operandAt(start + index));
	return coreAttributeValueHash(
		mixHash(hash, count),
		fn.instructionAttributes(instruction),
	);
}
