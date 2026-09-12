import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import { evaluateConstantOperation } from "../shared/constant-evaluator.ts";
import type { CoreInstructionId } from "./core-ir.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

// Pool snapshots are immutable and replaced on append, so weak keys also bound index lifetime.
const stringPoolSlots = new WeakMap<
	CoreProgram["stringConstants"],
	ReadonlyMap<string, number>
>();
const bigintPoolSlots = new WeakMap<
	CoreProgram["bigintConstants"],
	ReadonlyMap<string, number>
>();

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
	const queryKind = own
		? "has-own"
		: attributes.operation === "Array.prototype.includes"
			? "includes"
			: attributes.operation === "Array.prototype.indexOf"
				? "index-of"
				: attributes.operation === "Array.prototype.lastIndexOf"
					? "last-index-of"
					: undefined;
	if (queryKind === undefined) return undefined;
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
	if (queryKind === "has-own") {
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
		description.length > 0 &&
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
	let strings: ReadonlyMap<string, number> | undefined,
		bigints: ReadonlyMap<string, number> | undefined;
	for (let index = 0; index < description.length; index++) {
		const property = properties.get(String(index));
		if (property === undefined) {
			if (analysis.inherited(fact, String(index))?.kind !== "absent") return undefined;
			words.push(queryKind === "includes" ? 11 : 7);
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
				if (strings === undefined) {
					const pool = program.stringConstants;
					strings = stringPoolSlots.get(pool);
					if (strings === undefined) {
						strings = new Map(pool.map((units, index) => [units.join(","), index]));
						stringPoolSlots.set(pool, strings);
					}
				}
				const slot = strings.get(value.codeUnits.join(","));
				if (slot === undefined) return undefined;
				words.push(5, slot);
				break;
			}
			case "bigint": {
				if (bigints === undefined) {
					const pool = program.bigintConstants;
					bigints = bigintPoolSlots.get(pool);
					if (bigints === undefined) {
						bigints = new Map(pool.map((value, index) => [String(value), index]));
						bigintPoolSlots.set(pool, bigints);
					}
				}
				const slot = bigints.get(value.decimal);
				if (slot === undefined) return undefined;
				words.push(6, slot);
				break;
			}
			default:
				return undefined;
		}
	}
	const constantResult = (): number | boolean | undefined => {
		const includes = queryKind === "includes";
		const length = description.length!;
		if (length === 0) return includes ? false : -1;
		const backwards = queryKind === "last-index-of";
		let start = backwards ? length - 1 : 0;
		if (args[2] !== undefined) {
			const from = analysis.constant(args[2], instruction);
			// Array search uses ToNumber, whose BigInt rejection differs from Number().
			if (from === undefined || from.kind === "bigint") return undefined;
			const converted = evaluateConstantBuiltin("Number", undefined, [from]);
			if (converted.kind !== "value" || converted.value.kind !== "number")
				return undefined;
			const number = converted.value.value;
			const integer = Number.isNaN(number) ? 0 : Math.trunc(number);
			start = backwards
				? integer < 0
					? length + integer
					: Math.min(integer, length - 1)
				: integer < 0
					? Math.max(length + integer, 0)
					: integer;
		}
		if (start < 0 || start >= length) return includes ? false : -1;
		const needle =
			args[1] === undefined
				? ({ kind: "undefined" } as const)
				: analysis.constant(args[1], instruction);
		if (needle === undefined) return undefined;
		// Native literals wrap to i128; host equality is certified only inside that range.
		if (
			needle.kind === "bigint" &&
			evaluateConstantOperation("bigint.unary:tonumeric", [needle]).kind !== "value"
		)
			return undefined;
		let work = needle.kind === "string" ? needle.value.length : 0;
		for (let index = start; index >= 0 && index < length; index += backwards ? -1 : 1) {
			if (++work > 32768) return undefined;
			const property = properties.get(String(index));
			if (property === undefined) {
				if (includes && needle.kind === "undefined") return true;
				continue;
			}
			if (
				property.descriptor.kind !== "data" ||
				property.descriptor.value.kind !== "constant"
			)
				return undefined;
			const description = program.staticDescriptions.description(
				property.descriptor.value.description,
			);
			if (description.kind === "string") work += description.codeUnits.length;
			if (work > 32768) return undefined;
			const element = analysis.descriptionConstant(property.descriptor.value.description);
			if (element === undefined) return undefined;
			if (
				element.kind === "bigint" &&
				evaluateConstantOperation("bigint.unary:tonumeric", [element]).kind !== "value"
			)
				return undefined;
			if (
				element.kind === needle.kind &&
				(element.kind === "undefined" ||
					(needle.kind !== "undefined" && element.value === needle.value) ||
					(includes &&
						element.kind === "number" &&
						needle.kind === "number" &&
						Number.isNaN(element.value) &&
						Number.isNaN(needle.value)))
			)
				return includes ? true : index === 0 ? 0 : index;
		}
		return includes ? false : -1;
	};
	return { queryKind, args, fact, words, constantResult: constantResult() } as const;
}
