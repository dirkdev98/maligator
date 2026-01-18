import type { ESTree } from "meriyah";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { EngineValue } from "../types-and-values/data-types.ts";
import { getValue, ReferenceRecord } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const MemberExpression: Evaluator<"MemberExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-property-accessors
	evaluate(node) {
		const baseRef = evaluate(node.object);
		if (baseRef.type === "throw") {
			return baseRef;
		}
		const baseValue = getValue(baseRef.value);
		const isStrict = true;

		if (node.computed) {
			return evaluatePropertyAccessWithExpressionKey(baseValue, node.property, isStrict);
		}
		return evaluatePropertyAccessWithIdentifierKey(
			baseValue,
			(node.property as ESTree.Identifier).name,
			isStrict,
		);
	},
};

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-evaluate-property-access-with-expression-key
export function evaluatePropertyAccessWithExpressionKey(
	baseValue: EngineValue,
	expr: ESTree.Node,
	strict: boolean,
) {
	const propertyNameRef = evaluate(expr);
	if (propertyNameRef.type === "throw") {
		return propertyNameRef;
	}
	const propertyNameValue = getValue(propertyNameRef.value);

	return normalCompletion(
		new ReferenceRecord({
			base: baseValue,
			referencedName: propertyNameValue,
			strict,
			thisValue: undefined,
		}),
	);
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-evaluate-property-access-with-identifier-key
export function evaluatePropertyAccessWithIdentifierKey(
	baseValue: EngineValue,
	value: string,
	strict: boolean,
) {
	return normalCompletion(
		new ReferenceRecord({
			base: baseValue,
			referencedName: value,
			strict,
			thisValue: undefined,
		}),
	);
}
