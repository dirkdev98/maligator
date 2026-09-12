import type { WorldFacts } from "../shared/compiler-facts.ts";
import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import type { ConstantValue } from "../shared/constant-evaluator.ts";
import type { StaticDescriptionId } from "../shared/static-values.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export function coreStaticArrayJoin(
	program: CoreProgram,
	fn: CoreFunctionStore,
	world: WorldFacts,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
) {
	if (
		world.primordialPolicy !== "locked" ||
		world.realms ||
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (
		attributes.operation !== "Array.prototype.join" ||
		attributes.construct ||
		attributes.argumentMode !== undefined ||
		fn.kernel.instructionOperandCount(instruction) === 0
	)
		return undefined;
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const fact = analysis.queryAt(fn.kernel.operandAt(operandStart), instruction);
	if (fact.kind !== "known") return undefined;
	const array = program.staticDescriptions.description(fact.description);
	if (
		array.kind !== "array" ||
		array.length === null ||
		!Number.isSafeInteger(array.length) ||
		array.length < 0 ||
		array.length > 256 ||
		array.ownKeysComplete === false ||
		array.properties.length > 4096
	)
		return undefined;
	let work = 1 + array.properties.length + array.length;
	const constant = (description: StaticDescriptionId): ConstantValue | undefined => {
		const value = program.staticDescriptions.description(description);
		if (value.kind === "string" && value.codeUnits.length + work > 4096) return undefined;
		if (value.kind === "bigint" && value.decimal.length > 40) return undefined;
		return analysis.descriptionConstant(description);
	};
	const primitive = (input: CoreValueId): ConstantValue | undefined => {
		const value = analysis.queryAt(input, instruction);
		return value.kind === "known" ? constant(value.description) : undefined;
	};
	const text = (value: ConstantValue): string | undefined => {
		const converted = evaluateConstantBuiltin(
			"String",
			undefined,
			[value],
			undefined,
			4096 - work,
		);
		if (converted.kind !== "value" || converted.value.kind !== "string") return undefined;
		work += converted.work + converted.value.value.length;
		return work <= 4096 ? converted.value.value : undefined;
	};
	const separatorValue =
		fn.kernel.instructionOperandCount(instruction) < 2
			? { kind: "undefined" as const }
			: primitive(fn.kernel.operandAt(operandStart + 1));
	if (separatorValue === undefined) return undefined;
	const separator = separatorValue.kind === "undefined" ? "," : text(separatorValue);
	if (separator === undefined) return undefined;
	work += Math.max(array.length - 1, 0) * separator.length;
	if (work > 4096) return undefined;
	const properties = new Map(
		array.properties.map((property) => [property.key, property]),
	);
	const parts: Array<string> = [];
	for (let index = 0; index < array.length; index++) {
		const key = String(index),
			property = properties.get(key);
		if (property === undefined) {
			if (fact.prototype.kind !== "null") {
				work += array.properties.length + 1;
				if (work > 4096 || analysis.inherited(fact, key)?.kind !== "absent")
					return undefined;
			}
			parts.push("");
			continue;
		}
		if (property.descriptor.kind !== "data") return undefined;
		const member = property.descriptor.value;
		const value =
			member.kind === "constant"
				? constant(member.description)
				: member.kind === "operand" && fact.operands[member.index] !== undefined
					? primitive(fact.operands[member.index]!)
					: undefined;
		if (value === undefined) return undefined;
		const part = value.kind === "null" || value.kind === "undefined" ? "" : text(value);
		if (part === undefined) return undefined;
		parts.push(part);
	}
	return { fact, value: parts.join(separator) };
}
