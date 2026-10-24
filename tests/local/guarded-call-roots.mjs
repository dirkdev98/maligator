const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
if (typeof gc !== "function") throw new Error("guarded-call-roots requires explicit GC");

function retainBoolean(holder, input) {
	const method = Boolean;
	const held = holder.value;
	holder.value = null;
	try {
		const result = method(input);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainBoolean = retainBoolean;

function retainBooleanValue(holder, input) {
	const receiver = !!input;
	const held = holder.value;
	holder.value = null;
	try {
		const result = receiver.valueOf();
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainBooleanValue = retainBooleanValue;

function retainBooleanString(holder, input) {
	const receiver = !!input;
	const held = holder.value;
	holder.value = null;
	try {
		const result = receiver.toString();
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainBooleanString = retainBooleanString;

function retainNaN(holder, input) {
	const number = Number;
	const held = holder.value;
	holder.value = null;
	try {
		const result = number.isNaN(input);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainNaN = retainNaN;

function retainFinite(holder, input) {
	const number = Number;
	const held = holder.value;
	holder.value = null;
	try {
		const result = number.isFinite(input);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainFinite = retainFinite;

function retainInteger(holder, input) {
	const number = Number;
	const held = holder.value;
	holder.value = null;
	try {
		const result = number.isInteger(input);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainInteger = retainInteger;

function retainSafeInteger(holder, input) {
	const number = Number;
	const held = holder.value;
	holder.value = null;
	try {
		const result = number.isSafeInteger(input);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainSafeInteger = retainSafeInteger;

function retainAbs(holder, input) {
	const math = Math;
	const held = holder.value;
	holder.value = null;
	try {
		const result = math.abs(input);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainAbs = retainAbs;

function retainMin(holder, input) {
	const math = Math;
	const held = holder.value;
	holder.value = null;
	try {
		const result = math.min(input, 4);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainMin = retainMin;

function retainViewRead(holder, input) {
	const held = holder.value;
	holder.value = null;
	try {
		const result = input.getUint16(0, true);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainViewRead = retainViewRead;

function retainViewWrite(holder, input) {
	const held = holder.value;
	holder.value = null;
	try {
		const result = input.setUint16(0, 17, true);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainViewWrite = retainViewWrite;

function retainCharCode(holder, input) {
	const held = holder.value;
	holder.value = null;
	try {
		const result = input.charCodeAt(1);
		gc();
		return [held.marker, result];
	} catch (error) {
		gc();
		return [held.marker, error.marker];
	}
}
globalThis.retainCharCode = retainCharCode;

function view() {
	return new DataView(new Uint8Array([0x34, 0x12]).buffer);
}
const cases = [
	["retainBoolean", globalThis, "Boolean", false, false],
	["retainBooleanValue", Boolean.prototype, "valueOf", true, true],
	["retainBooleanString", Boolean.prototype, "toString", true, "true"],
	["retainNaN", Number, "isNaN", NaN, true],
	["retainFinite", Number, "isFinite", 12, true],
	["retainInteger", Number, "isInteger", 1.5, false],
	["retainSafeInteger", Number, "isSafeInteger", 2 ** 53, false],
	["retainAbs", Math, "abs", -2, 2],
	["retainMin", Math, "min", 2, 2],
	["retainViewRead", DataView.prototype, "getUint16", view(), 0x1234],
	["retainViewWrite", DataView.prototype, "setUint16", view(), undefined],
	["retainCharCode", String.prototype, "charCodeAt", "abc", 98],
];
let marker = 0;
function invoke(name, input, expected) {
	const id = ++marker;
	const holder = { value: { marker: id } };
	const result = globalThis[name](holder, input);
	if (holder.value !== null || result[0] !== id)
		throw new Error("lost held value in " + name);
	const actual = result[1];
	if ((actual && typeof actual === "object" ? actual.marker : actual) !== expected)
		throw new Error("unexpected result in " + name);
}
for (const [name, owner, key, input, expected] of cases) {
	const original = owner[key];
	try {
		invoke(name, input, expected);
		owner[key] = function () {
			gc();
			return { marker: "returned" };
		};
		invoke(name, input, "returned");
		owner[key] = function () {
			gc();
			throw { marker: "thrown" };
		};
		invoke(name, input, "thrown");
	} finally {
		owner[key] = original;
	}
}
console.log("guarded-call-roots PASS");
