import { EngineValue } from "../data-types.ts";
import { isArrayExoticObject } from "./array-exotic.ts";
import { normalCompletion, throwCompletion } from "./completion-record.ts";
import type { CompletionRecord } from "./completion-record.ts";
import { StringToBigInt, toNumber, toNumeric, toPrimitive } from "./type-conversion.ts";

export const UNUSED = -1;

// https://tc39.es/ecma262/#sec-requireobjectcoercible
export function requireObjectCoercible(
	argument: EngineValue,
): CompletionRecord<typeof UNUSED> {
	if (argument.isUndefined() || argument.isNull()) {
		return throwCompletion(new TypeError(`Argument can't be converted to an object.`));
	}

	return normalCompletion(UNUSED);
}

// https://tc39.es/ecma262/#sec-isarray
export function isArray(value: EngineValue): CompletionRecord<EngineValue<"boolean">> {
	if (!value.isObject()) {
		return normalCompletion(EngineValue.boolean(false));
	}

	if (isArrayExoticObject(value)) {
		return normalCompletion(EngineValue.boolean(true));
	}

	throw new Error("Not implemented. Needs Proxy object detection.");

	return normalCompletion(EngineValue.boolean(false));
}

// https://tc39.es/ecma262/#sec-iscallable
export function isCallable(argument: EngineValue) {
	if (!argument.isObject()) {
		return EngineValue.boolean(false);
	}

	return EngineValue.boolean(argument.objectHasInternalSlot("Call"));
}

// https://tc39.es/ecma262/#sec-isconstructor
export function isConstructor(argument: EngineValue) {
	if (!argument.isObject()) {
		return EngineValue.boolean(false);
	}

	return EngineValue.boolean(argument.objectHasInternalSlot("Construct"));
}

// https://tc39.es/ecma262/#sec-isextensible-o
export function isExtensible(O: EngineValue<"object">) {
	return O.objectGetInternalSlot("IsExtensible")(O);
}

// https://tc39.es/ecma262/#sec-isregexp
export function isRegExp(
	_argument: EngineValue,
): CompletionRecord<EngineValue<"boolean">> {
	throw new Error("Not implemented. Needs Get support");
}

// https://tc39.es/ecma262/#sec-sametype
export function sameType(x: EngineValue, y: EngineValue): boolean {
	return x.type === y.type;
}

export function sameTypeWrapped(x: EngineValue, y: EngineValue) {
	return EngineValue.boolean(sameType(x, y));
}

// https://tc39.es/ecma262/#sec-samevalue
export function sameValue(x: EngineValue, y: EngineValue): boolean {
	if (!sameType(x, y)) {
		return false;
	}

	if (x.isNumber() && y.isNumber()) {
		return x.numberSameValue(y).data.value;
	}

	return sameValueNonNumber(x, y);
}

export function sameValueWrapped(x: EngineValue, y: EngineValue) {
	return EngineValue.boolean(sameValue(x, y));
}

// https://tc39.es/ecma262/#sec-samevaluezero
export function sameValueZero(x: EngineValue, y: EngineValue): boolean {
	if (!sameType(x, y)) {
		return false;
	}

	if (x.isNumber() && y.isNumber()) {
		return x.numberSameValueZero(y).data.value;
	}

	return sameValueNonNumber(x, y);
}

export function sameValueZeroWrapped(x: EngineValue, y: EngineValue) {
	return EngineValue.boolean(sameValueZero(x, y));
}

// https://tc39.es/ecma262/#sec-samevaluenonnumber
export function sameValueNonNumber(x: EngineValue, y: EngineValue): boolean {
	if (!sameType(x, y)) {
		return false;
	}

	if (x.isUndefined() || x.isNull()) {
		return true;
	}

	if (x.isBigInt() && y.isBigInt()) {
		return x.bigintEqual(y).data.value;
	}

	if (x.isString() && y.isString()) {
		return x.data.value === y.data.value;
	}

	if (x.isBoolean() && y.isBoolean()) {
		return x.data.value === y.data.value;
	}

	return x === y;
}

export function sameValueNonNumberWrapped(x: EngineValue, y: EngineValue) {
	return EngineValue.boolean(sameValueNonNumber(x, y));
}

// https://tc39.es/ecma262/#sec-islessthan
export function isLessThan(
	x: EngineValue,
	y: EngineValue,
	leftFirst: boolean = true,
): CompletionRecord<EngineValue<"boolean" | "undefined">> {
	let px, py;
	if (leftFirst) {
		const pxc = toPrimitive(x, "number");
		if (pxc.type === "throw") {
			return pxc;
		}
		px = pxc.value;

		const pyc = toPrimitive(y, "number");
		if (pyc.type === "throw") {
			return pyc;
		}
		py = pyc.value;
	} else {
		const pyc = toPrimitive(y, "number");
		if (pyc.type === "throw") {
			return pyc;
		}
		py = pyc.value;

		const pxc = toPrimitive(x, "number");
		if (pxc.type === "throw") {
			return pxc;
		}
		px = pxc.value;
	}

	if (px.isString() && py.isString()) {
		const lx = px.data.value.length;
		const ly = py.data.value.length;

		for (let i = 0; i < Math.min(lx, ly); ++i) {
			const cx = px.data.value.charCodeAt(i);
			const cy = py.data.value.charCodeAt(i);

			if (cx < cy) {
				return normalCompletion(EngineValue.boolean(true));
			} else if (cx > cy) {
				return normalCompletion(EngineValue.boolean(false));
			}
		}

		return normalCompletion(EngineValue.boolean(lx < ly));
	}

	if (px.isBigInt() && py.isString()) {
		const ny = StringToBigInt(py.data.value);
		if (ny.isUndefined()) {
			return normalCompletion(EngineValue.undefined());
		}

		return normalCompletion(px.bigintLessThan(ny));
	}

	if (px.isString() && py.isBigInt()) {
		const nx = StringToBigInt(px.data.value);

		if (nx.isUndefined()) {
			return normalCompletion(EngineValue.undefined());
		}

		return normalCompletion(nx.bigintLessThan(py));
	}

	const nx = toNumeric(px);
	if (nx.type === "throw") {
		return nx;
	}
	const ny = toNumeric(py);
	if (ny.type === "throw") {
		return ny;
	}

	if (sameType(nx.value, ny.value)) {
		if (nx.value.isNumber() && ny.value.isNumber()) {
			return normalCompletion(nx.value.numberLessThan(ny.value));
		}
		return normalCompletion(nx.value.asBigInt().bigintLessThan(ny.value.asBigInt()));
	}

	if (
		(nx.value.isNumber() && isNaN(nx.value.data.value)) ||
		(ny.value.isNumber() && isNaN(ny.value.data.value))
	) {
		return normalCompletion(EngineValue.undefined());
	}

	if (
		(nx.value.isNumber() && nx.value.data.value === -Infinity) ||
		(ny.value.isNumber() && ny.value.data.value === +Infinity)
	) {
		return normalCompletion(EngineValue.boolean(true));
	}

	if (
		(nx.value.isNumber() && nx.value.data.value === +Infinity) ||
		(ny.value.isNumber() && ny.value.data.value === -Infinity)
	) {
		return normalCompletion(EngineValue.boolean(false));
	}

	return normalCompletion(EngineValue.boolean(nx.value.data.value < ny.value.data.value));
}

// https://tc39.es/ecma262/#sec-islooselyequal
export function isLooselyEqual(
	x: EngineValue,
	y: EngineValue,
): CompletionRecord<EngineValue<"boolean">> {
	if (sameValue(x, y)) {
		return normalCompletion(isStrictlyEqual(x, y));
	}

	if (x.isNull() && y.isUndefined()) {
		return normalCompletion(EngineValue.boolean(true));
	}

	if (x.isUndefined() && y.isNull()) {
		return normalCompletion(EngineValue.boolean(true));
	}

	if (x.isNumber() && y.isString()) {
		const yN = toNumber(y);
		if (yN.type === "throw") {
			return yN;
		}

		return isLooselyEqual(x, yN.value);
	}

	if (x.isString() && y.isNumber()) {
		const xN = toNumber(x);
		if (xN.type === "throw") {
			return xN;
		}

		return isLooselyEqual(xN.value, y);
	}

	if (x.isBigInt() && y.isString()) {
		const n = StringToBigInt(y.data.value);
		if (n.isUndefined()) {
			return normalCompletion(EngineValue.boolean(false));
		}

		return isLooselyEqual(x, n);
	}

	if (x.isBoolean()) {
		const xN = toNumber(x);
		if (xN.type === "throw") {
			return xN;
		}

		return isLooselyEqual(xN.value, y);
	}

	if (y.isBoolean()) {
		const yN = toNumber(y);
		if (yN.type === "throw") {
			return yN;
		}
		return isLooselyEqual(x, yN.value);
	}

	if ((x.isString() || x.isNumber() || x.isBigInt() || x.isSymbol()) && y.isObject()) {
		const yN = toPrimitive(y);
		if (yN.type === "throw") {
			return yN;
		}
		return isLooselyEqual(x, yN.value);
	}

	if (x.isObject() && (y.isString() || y.isNumber() || y.isBigInt() || y.isSymbol())) {
		const xN = toPrimitive(x);
		if (xN.type === "throw") {
			return xN;
		}
		return isLooselyEqual(xN.value, y);
	}

	if ((x.isNumber() && y.isBigInt()) || (x.isBigInt() && y.isNumber())) {
		const xV = x.data.value;
		const yV = y.data.value;

		if (!isFinite(Number(xV)) || !isFinite(Number(yV))) {
			return normalCompletion(EngineValue.boolean(false));
		}

		return normalCompletion(EngineValue.boolean(Number(xV) === Number(yV)));
	}

	return normalCompletion(EngineValue.boolean(false));
}

// https://tc39.es/ecma262/#sec-isstrictlyequal
export function isStrictlyEqual(x: EngineValue, y: EngineValue): EngineValue<"boolean"> {
	if (!sameType(x, y)) {
		return EngineValue.boolean(false);
	}

	if (x.isNumber() && y.isNumber()) {
		return x.numberEqual(y);
	}

	return sameValueNonNumberWrapped(x, y);
}
