import type { WorldFacts } from "../shared/compiler-facts.ts";
import { MAX_PRECISE_NUMBER_SUM_INPUTS } from "../shared/compiler-instruction.ts";
import { evaluateConstantNumberSum } from "../shared/constant-number-sum.ts";
import { provePrimordialAccess } from "../shared/primordial-catalog.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreStaticMemberOperation } from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreProgram } from "./core-store.ts";

export function coreStaticNumberSum(
	program: CoreProgram,
	world: WorldFacts,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	input: CoreValueId | undefined,
) {
	if (input === undefined) return undefined;
	const fact = analysis.queryAt(input, instruction);
	if (fact.kind !== "known" || !fact.privateUntilObservation) return undefined;
	const array = program.staticDescriptions.description(fact.description);
	if (
		array.kind !== "array" ||
		array.length === null ||
		array.length > MAX_PRECISE_NUMBER_SUM_INPUTS ||
		array.ownKeysComplete === false ||
		fact.prototype.kind !== "intrinsic" ||
		fact.prototype.id !== "Array.prototype" ||
		analysis.inherited(fact, { symbol: "%Symbol.iterator%" })?.resolution?.value?.[0] !==
			"Array.prototype.values"
	)
		return undefined;
	const iterator = {
		kind: "intrinsic" as const,
		id: "%MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE%",
		realm: "current" as const,
	};
	if (
		provePrimordialAccess(world, iterator, "next")?.resolution?.value?.[0] !==
			"%MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE%.next" ||
		provePrimordialAccess(world, iterator, "return")?.kind !== "absent"
	)
		return undefined;
	const values: Array<number> = [],
		elements: Array<CoreStaticMemberOperation> = [];
	for (let index = 0; index < array.length; index++) {
		const property = array.properties.find((property) => property.key === String(index));
		if (
			property === undefined &&
			analysis.inherited(fact, String(index))?.kind === "absent"
		)
			return { error: "sumNumber" as const };
		if (property?.descriptor.kind !== "data") return undefined;
		const member = property.descriptor.value;
		const operand = member.kind === "operand" ? fact.operands[member.index] : undefined;
		const value =
			member.kind === "constant"
				? analysis.descriptionConstant(member.description)
				: operand === undefined
					? undefined
					: analysis.constant(operand, instruction);
		if (value?.kind === "number") values.push(value.value);
		else {
			const element =
				operand === undefined ? undefined : analysis.queryAt(operand, instruction);
			if (
				value !== undefined ||
				(element?.kind === "known" &&
					[
						"undefined",
						"null",
						"boolean",
						"string",
						"bigint",
						"symbol",
						"object",
						"array",
						"function",
					].includes(element.brand))
			)
				return { error: "sumNumber" as const };
			if (element?.kind !== "known" || element.brand !== "number") return undefined;
		}
		const operation = coreStaticMemberOperation(program, member, fact.operands);
		if (operation === undefined) return undefined;
		elements.push(operation);
	}
	if (values.length === array.length) {
		const evaluated = evaluateConstantNumberSum(values);
		if (evaluated.kind === "value") return { value: evaluated.value };
	}
	if (elements.length > 0) return { elements };
	return undefined;
}
