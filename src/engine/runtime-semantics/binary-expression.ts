import {
	isLooselyEqual,
	isStrictlyEqual,
	sameType,
} from "../abstract-operations/testing-and-comparison.ts";
import {
	toNumeric,
	toPrimitive,
	toString,
} from "../abstract-operations/type-conversion.ts";
import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const BinaryExpression: Evaluator<"BinaryExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-evaluatestringornumericbinaryexpression
	evaluate(node) {
		const lRef = evaluate(node.left);
		if (lRef.type === "throw") {
			return lRef;
		}
		const lVal = getValue(lRef.value);

		const rRef = evaluate(node.right);
		if (rRef.type === "throw") {
			return rRef;
		}

		const rVal = getValue(rRef.value);

		if (["==", "!=", "===", "!=="].includes(node.operator)) {
			return ApplyEqualityBinaryOperator(lVal, node.operator, rVal);
		}

		return ApplyStringOrNumericBinaryOperator(lVal, node.operator, rVal);
	},
};

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-applystringornumericbinaryoperator
function ApplyStringOrNumericBinaryOperator(
	lValue: EngineValue,
	opText: string,
	rValue: EngineValue,
): CompletionRecord<EngineValue> {
	if (opText === "+") {
		const lPrim = toPrimitive(lValue);
		if (lPrim.type === "throw") {
			return lPrim;
		}
		const rPrim = toPrimitive(rValue);
		if (rPrim.type === "throw") {
			return rPrim;
		}

		if (lPrim.value.isString() || rPrim.value.isString()) {
			const lStr = toString(lPrim.value);
			if (lStr.type === "throw") {
				return lStr;
			}
			const rStr = toString(rPrim.value);
			if (rStr.type === "throw") {
				return rStr;
			}

			return normalCompletion(
				EngineValue.string(lStr.value.data.value + rStr.value.data.value),
			);
		}

		lValue = lPrim.value;
		rValue = rPrim.value;
	}

	const lNum = toNumeric(lValue);
	if (lNum.type === "throw") {
		return lNum;
	}
	const rNum = toNumeric(rValue);
	if (rNum.type === "throw") {
		return rNum;
	}

	if (!sameType(lNum.value, rNum.value)) {
		return throwCompletion(
			new TypeError("Binary operation failed. Both operands are not of the same type."),
		);
	}

	if (lNum.value.isBigInt() && rNum.value.isBigInt()) {
		switch (opText) {
			case "**":
				return lNum.value.bigintExponentiate(rNum.value);
			case "/":
				return lNum.value.bigintDivide(rNum.value);
			case "%":
				return lNum.value.bigintRemainder(rNum.value);
			case ">>>":
				return lNum.value.bigintUnsignedRightShift(rNum.value);
			case "*":
				return normalCompletion(lNum.value.bigintMultiply(rNum.value));
			case "+":
				return normalCompletion(lNum.value.bigintAdd(rNum.value));
			case "-":
				return normalCompletion(lNum.value.bigintSubtract(rNum.value));
			case "<<":
				return normalCompletion(lNum.value.bigintLeftShift(rNum.value));
			case ">>":
				return normalCompletion(lNum.value.bigintSignedRightShift(rNum.value));
			case "&":
				return normalCompletion(lNum.value.bigintBitwiseAND(rNum.value));
			case "^":
				return normalCompletion(lNum.value.bigintBitwiseXOR(rNum.value));
			case "|":
				return normalCompletion(lNum.value.bigintBitwiseOR(rNum.value));

			default:
				return throwCompletion(
					new TypeError(`Binary operation failed. Unknown operator '${opText}'.`),
				);
		}
	} else if (lNum.value.isNumber() && rNum.value.isNumber()) {
		switch (opText) {
			case "**":
				return normalCompletion(lNum.value.numberExponentiate(rNum.value));
			case "*":
				return normalCompletion(lNum.value.numberMultiply(rNum.value));
			case "/":
				return normalCompletion(lNum.value.numberDivide(rNum.value));
			case "%":
				return normalCompletion(lNum.value.numberRemainder(rNum.value));
			case "+":
				return normalCompletion(lNum.value.numberAdd(rNum.value));
			case "-":
				return normalCompletion(lNum.value.numberSubtract(rNum.value));
			case "<<":
				return normalCompletion(lNum.value.numberLeftShift(rNum.value));
			case ">>":
				return normalCompletion(lNum.value.numberSignedRightShift(rNum.value));
			case ">>>":
				return normalCompletion(lNum.value.numberUnsignedRightShift(rNum.value));
			case "&":
				return normalCompletion(lNum.value.numberBitwiseAND(rNum.value));
			case "^":
				return normalCompletion(lNum.value.numberBitwiseXOR(rNum.value));
			case "|":
				return normalCompletion(lNum.value.numberBitwiseOR(rNum.value));

			default:
				return throwCompletion(
					new TypeError(`Binary operation failed. Unknown operator '${opText}'.`),
				);
		}
	}

	throw new Error("Not implemented.");
}

// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-equality-operators
function ApplyEqualityBinaryOperator(
	lValue: EngineValue,
	opText: string,
	rValue: EngineValue,
): CompletionRecord<EngineValue> {
	switch (opText) {
		case "==":
			return isLooselyEqual(rValue, lValue);
		case "!=": {
			const r = isLooselyEqual(rValue, lValue);
			if (r.type === "throw") {
				return r;
			}
			return normalCompletion(EngineValue.boolean(!r.value.data.value));
		}
		case "===":
			return normalCompletion(isStrictlyEqual(rValue, lValue));
		case "!==": {
			const r = isStrictlyEqual(rValue, lValue);
			return normalCompletion(EngineValue.boolean(!r.data.value));
		}

		default:
			throw new Error(`Unknown equality operator: ${opText}`);
	}
}
