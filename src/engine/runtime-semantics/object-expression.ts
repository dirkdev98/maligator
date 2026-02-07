import {
	copyDataProperties,
	createDataPropertyOrThrow,
} from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { toPropertyKey } from "../abstract-operations/type-conversion.ts";
import { getCurrentRealm } from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { getValue } from "../types-and-values/reference-record.ts";
import { evaluate } from "./index.ts";
import type { Evaluator } from "./index.ts";

export const ObjectExpression: Evaluator<"ObjectExpression"> = {
	// https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-object-initializer-runtime-semantics-evaluation
	evaluate(node) {
		const obj = ordinaryObjectCreate(
			getCurrentRealm().intrinsics["%Object.prototype%"]!.asObject(),
		);

		for (const prop of node.properties) {
			if (prop.type === "Property") {
				if (prop.key.type === "Identifier") {
					const key = prop.key.name;
					const value = evaluate(prop.value);
					if (value.type === "throw") {
						return value;
					}

					const vValue = getValue(value.value);
					createDataPropertyOrThrow(obj, key, vValue);
				} else {
					const key = evaluate(prop.key);
					if (key.type === "throw") {
						return key;
					}
					const keyValue = getValue(key.value);
					const keyString = toPropertyKey(keyValue);
					if (keyString.type === "throw") {
						return keyString;
					}

					const value = evaluate(prop.value);
					if (value.type === "throw") {
						return value;
					}

					const vValue = getValue(value.value);
					createDataPropertyOrThrow(obj, keyString.value, vValue);
				}
			} else if (prop.type === "SpreadElement") {
				const arg = evaluate(prop.argument);
				if (arg.type === "throw") {
					return arg;
				}
				const argValue = getValue(arg.value);
				const argObj = argValue.asObject();

				copyDataProperties(obj, argObj, []);
			}
		}

		return normalCompletion(obj);
	},
};
