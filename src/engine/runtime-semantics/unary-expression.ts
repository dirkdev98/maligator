import type { ESTree } from "meriyah";
import { isPropertyKey, unwrapPropertyKey } from "../abstract-operations/property-map.ts";
import {
	toBoolean,
	toNumber,
	toNumeric,
	toObject,
	toPropertyKey,
} from "../abstract-operations/type-conversion.ts";
import {
	normalCompletion,
	throwCompletion,
	unwrapCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { getValue, ReferenceRecord } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

type EvaluateReturnType = ReturnType<Evaluator<"UnaryExpression">["evaluate"]>;

export const UnaryExpression: Evaluator<"UnaryExpression"> = {
	evaluate(node) {
		switch (node.operator) {
			case "delete":
				return deleteUnaryExpression(node);
			case "void":
				return voidUnaryExpression(node);
			case "typeof":
				return typeofUnaryExpression(node);
			case "+":
				return plusUnaryExpression(node);
			case "-":
				return minusUnaryExpression(node);
			case "~":
				return bitwiseNotUnaryExpression(node);
			case "!":
				return logicalNotUnaryExpression(node);
			default:
				return normalCompletion(undefined);
		}
	},
};

function deleteUnaryExpression(node: ESTree.UnaryExpression): EvaluateReturnType {
	const ref = evaluate(node.argument);
	if (ref.type === "throw") {
		return ref;
	}
	if (!(ref.value instanceof ReferenceRecord)) {
		return normalCompletion(EngineValue.boolean(true));
	}

	if (ref.value.isUnresolvableReference()) {
		// TODO: strict check;
		return normalCompletion(EngineValue.boolean(true));
	}

	if (ref.value.isPropertyReference()) {
		if (ref.value.isSuperReference()) {
			return throwCompletion(new ReferenceError("Cannot delete property of super"));
		}

		const base = toObject(ref.value.getPropertyBase());
		if (base.type === "throw") {
			return base;
		}

		if (!isPropertyKey(ref.value.referencedName)) {
			ref.value.referencedName = unwrapCompletion(
				toPropertyKey(ref.value.referencedName as EngineValue),
			);
		}

		const deleteStatus = base.value.objectGetInternalSlot("Delete")(
			base.value.asObject(),
			unwrapPropertyKey(ref.value.referencedName),
		);
		if (deleteStatus.type === "throw") {
			return deleteStatus;
		}

		if (!deleteStatus.value.data.value && ref.value.strict) {
			return throwCompletion(new TypeError("Cannot delete property of primitive value"));
		}

		return deleteStatus;
	}

	const base = ref.value.getEnvironmentRecordBase();
	return normalCompletion(
		EngineValue.boolean(
			base.deleteBinding(unwrapPropertyKey(ref.value.referencedName) as string),
		),
	);
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-void-operator-runtime-semantics-evaluation
function voidUnaryExpression(node: ESTree.UnaryExpression): EvaluateReturnType {
	const ref = evaluate(node.argument);
	if (ref.type === "throw") {
		return ref;
	}
	getValue(ref.value);

	return normalCompletion(EngineValue.undefined());
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-typeof-operator
function typeofUnaryExpression(node: ESTree.UnaryExpression): EvaluateReturnType {
	const ref = evaluate(node.argument);

	if (ref.type === "throw") {
		return ref;
	}

	if (ref.value instanceof ReferenceRecord && ref.value.isUnresolvableReference()) {
		return normalCompletion(EngineValue.string("undefined"));
	}

	const val = getValue(ref.value);
	if (val.isUndefined()) {
		return normalCompletion(EngineValue.string("undefined"));
	}

	if (val.isNull()) {
		return normalCompletion(EngineValue.string("object"));
	}

	if (val.isString()) {
		return normalCompletion(EngineValue.string("string"));
	}
	if (val.isSymbol()) {
		return normalCompletion(EngineValue.string("symbol"));
	}
	if (val.isBoolean()) {
		return normalCompletion(EngineValue.string("boolean"));
	}
	if (val.isNumber()) {
		return normalCompletion(EngineValue.string("number"));
	}
	if (val.isBigInt()) {
		return normalCompletion(EngineValue.string("bigint"));
	}

	if (val.asObject().objectHasInternalSlot("Call")) {
		return normalCompletion(EngineValue.string("function"));
	}

	return normalCompletion(EngineValue.string("object"));
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-unary-plus-operator
function plusUnaryExpression(node: ESTree.UnaryExpression): EvaluateReturnType {
	const ref = evaluate(node.argument);

	if (ref.type === "throw") {
		return ref;
	}

	return toNumber(getValue(ref.value));
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-unary-minus-operator
function minusUnaryExpression(node: ESTree.UnaryExpression): EvaluateReturnType {
	const ref = evaluate(node.argument);

	if (ref.type === "throw") {
		return ref;
	}

	const num = toNumeric(getValue(ref.value));
	if (num.type === "throw") {
		return num;
	}

	if (num.value.isNumber()) {
		return normalCompletion(num.value.numberUnaryMinus());
	}

	return normalCompletion(num.value.asBigInt().bigintUnaryMinus());
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-bitwise-not-operator
function bitwiseNotUnaryExpression(node: ESTree.UnaryExpression): EvaluateReturnType {
	const ref = evaluate(node.argument);

	if (ref.type === "throw") {
		return ref;
	}

	const num = toNumeric(getValue(ref.value));
	if (num.type === "throw") {
		return num;
	}

	if (num.value.isNumber()) {
		return normalCompletion(num.value.numberBitwiseNot());
	}

	return normalCompletion(num.value.asBigInt().bigintBitwiseNOT());
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-logical-not-operator
function logicalNotUnaryExpression(node: ESTree.UnaryExpression): EvaluateReturnType {
	const ref = evaluate(node.argument);

	if (ref.type === "throw") {
		return ref;
	}

	const bool = toBoolean(getValue(ref.value));
	return normalCompletion(EngineValue.boolean(!bool.data.value));
}
