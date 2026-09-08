import type { CoreInstructionId } from "./core-ir.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export function coreStaticDataQueryPlan(
	program: CoreProgram,
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
) {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
	const own =
		attributes.operation === "Object.prototype.hasOwnProperty" ||
		attributes.operation === "Object.hasOwn";
	if (!own && attributes.operation !== "Array.prototype.includes") return undefined;
	const receiverIndex = attributes.operation === "Object.hasOwn" ? 1 : 0;
	if (fn.kernel.instructionOperandCount(instruction) <= receiverIndex) return undefined;
	const args = Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) - receiverIndex },
		(_, index) =>
			fn.kernel.operandAt(
				fn.kernel.instructionOperandStart(instruction) + receiverIndex + index,
			),
	);
	const fact = analysis.queryAt(args[0]!, instruction);
	if (fact.kind !== "known") return undefined;
	const description = program.staticDescriptions.description(fact.description);
	if (
		(description.kind !== "object" && description.kind !== "array") ||
		description.ownKeysComplete === false
	)
		return undefined;
	if (own) {
		if (
			!fact.privateUntilObservation ||
			description.properties.length > 32768 ||
			description.properties.some(({ key }) => typeof key !== "string")
		)
			return undefined;
		const keys = description.properties.map(({ key }) => key as string);
		if (description.kind === "array" && !keys.includes("length")) keys.push("length");
		return { queryKind: "has-own" as const, args, fact, keys };
	}
	if (
		description.kind !== "array" ||
		description.length === null ||
		description.length > 32768
	)
		return undefined;
	if (
		args[2] !== undefined &&
		analysis.constant(args[2]) === undefined &&
		!fact.privateUntilObservation
	)
		return undefined;
	const words: Array<number> = [8, description.length];
	const bits = new DataView(new ArrayBuffer(8));
	const properties = new Map(
		description.properties.map((property) => [property.key, property]),
	);
	let strings: Map<string, number> | undefined, bigints: Map<string, number> | undefined;
	for (let index = 0; index < description.length; index++) {
		const property = properties.get(String(index));
		if (property === undefined) {
			if (analysis.inherited(fact, String(index))?.kind !== "absent") return undefined;
			words.push(11);
			continue;
		}
		if (
			property.descriptor.kind !== "data" ||
			property.descriptor.value.kind !== "constant"
		)
			return undefined;
		const value = program.staticDescriptions.description(
			property.descriptor.value.description,
		);
		switch (value.kind) {
			case "null":
				words.push(0);
				break;
			case "undefined":
				words.push(11);
				break;
			case "boolean":
				words.push(value.value ? 2 : 1);
				break;
			case "number": {
				bits.setUint32(0, value.low, true);
				bits.setUint32(4, value.high, true);
				const number = bits.getFloat64(0, true);
				if (
					Number.isInteger(number) &&
					number >= -2147483648 &&
					number <= 2147483647 &&
					!Object.is(number, -0)
				)
					words.push(3, number >>> 0);
				else words.push(4, value.low, value.high);
				break;
			}
			case "string": {
				strings ??= new Map(
					program.stringConstants.map((units, index) => [units.join(","), index]),
				);
				const slot = strings.get(value.codeUnits.join(","));
				if (slot === undefined) return undefined;
				words.push(5, slot);
				break;
			}
			case "bigint": {
				bigints ??= new Map(
					program.bigintConstants.map((value, index) => [String(value), index]),
				);
				const slot = bigints.get(value.decimal);
				if (slot === undefined) return undefined;
				words.push(6, slot);
				break;
			}
			default:
				return undefined;
		}
	}
	return { queryKind: "includes" as const, args, fact, words };
}
