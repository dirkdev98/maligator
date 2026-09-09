import type { ConstantValue } from "../shared/constant-evaluator.ts";
import { isStringCollationPlan } from "../shared/string-collation-plan.ts";
import type { StringCollationPlan } from "../shared/string-collation-plan.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreProgram } from "./core-store.ts";

const observedOptions = new Set([
	"usage",
	"localeMatcher",
	"collation",
	"ignorePunctuation",
	"sensitivity",
	"caseFirst",
	"numeric",
]);

export function coreStringCollationPlan(
	program: CoreProgram,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	inputs: ReadonlyArray<CoreValueId>,
): StringCollationPlan | undefined {
	const localeValue =
		inputs[2] === undefined
			? { kind: "undefined" as const }
			: analysis.constant(inputs[2]);
	if (localeValue?.kind !== "undefined" && localeValue?.kind !== "string")
		return undefined;
	const locale = localeValue.kind === "undefined" ? "en-US" : localeValue.value;
	const defaults = { locale, options: 2 };
	if (!isStringCollationPlan(defaults)) return undefined;
	const optionsValue = inputs[3];
	if (optionsValue === undefined || analysis.constant(optionsValue)?.kind === "undefined")
		return defaults;
	// Receiver/argument coercion must not reenter and mutate the captured option data.
	if (
		inputs.slice(0, 2).some((value) => {
			const fact = analysis.query(value);
			return (
				fact.kind !== "known" ||
				![
					"string",
					"number",
					"boolean",
					"bigint",
					"symbol",
					"null",
					"undefined",
				].includes(fact.brand)
			);
		})
	)
		return undefined;
	const fact = analysis.queryAt(optionsValue, instruction);
	if (fact.kind !== "known" || !fact.privateUntilObservation) return undefined;
	const description = program.staticDescriptions.description(fact.description);
	if (
		description.kind !== "object" ||
		!description.ownKeysComplete ||
		(description.prototype.kind !== "null" &&
			!(
				description.prototype.kind === "intrinsic" &&
				description.prototype.id === "Object.prototype"
			))
	)
		return undefined;
	const options = new Map<string, ConstantValue>();
	for (const property of description.properties) {
		if (typeof property.key !== "string" || !observedOptions.has(property.key)) continue;
		if (property.descriptor.kind !== "data") return undefined;
		const member = property.descriptor.value;
		const constant =
			member.kind === "constant"
				? analysis.descriptionConstant(member.description)
				: member.kind === "operand"
					? analysis.constant(fact.operands[member.index]!)
					: undefined;
		if (constant === undefined) return undefined;
		options.set(property.key, constant);
	}
	const enumValue = (
		name: string,
		values: ReadonlyArray<string>,
		fallback: string,
	): string | undefined => {
		const value = options.get(name);
		return value === undefined || value.kind === "undefined"
			? fallback
			: value.kind === "string" && values.includes(value.value)
				? value.value
				: undefined;
	};
	const truthy = (value: ConstantValue | undefined): boolean =>
		value === undefined || value.kind === "undefined" || value.kind === "null"
			? false
			: value.kind === "boolean"
				? value.value
				: value.kind === "number"
					? value.value !== 0 && !Number.isNaN(value.value)
					: value.kind === "string"
						? value.value.length !== 0
						: value.value !== 0n;
	if (
		enumValue("usage", ["sort"], "sort") === undefined ||
		enumValue("localeMatcher", ["lookup", "best fit"], "best fit") === undefined ||
		(options.has("collation") && options.get("collation")!.kind !== "undefined") ||
		truthy(options.get("ignorePunctuation"))
	)
		return undefined;
	const sensitivity = enumValue(
		"sensitivity",
		["base", "accent", "case", "variant"],
		"variant",
	);
	const caseFirst = enumValue("caseFirst", ["false", "upper", "lower"], "false");
	if (sensitivity === undefined || caseFirst === undefined) return undefined;
	const strength =
		sensitivity === "base" || sensitivity === "case"
			? 0
			: sensitivity === "accent"
				? 1
				: 2;
	return {
		locale,
		options:
			strength |
			(sensitivity === "case" ? 4 : 0) |
			(truthy(options.get("numeric")) ? 8 : 0) |
			(caseFirst === "upper" ? 16 : caseFirst === "lower" ? 32 : 0),
	};
}
