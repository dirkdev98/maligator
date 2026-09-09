const results = [],
	events = [];
function method(x) {
	globalThis.sink(x);
	return Boolean(x).toString(events.push("argument"));
}
function convert(x) {
	globalThis.sink(x);
	return String(Boolean(x), events.push("argument"));
}
function template(x) {
	globalThis.sink(x);
	return `${!!x}`;
}
function adapted(x) {
	return Boolean.prototype.toString.call(Boolean(x));
}
function wrapped(x) {
	return new Boolean(x).toString();
}
function mixed(x) {
	return `${x ? true : 7}`;
}
globalThis.sink = () => {};
globalThis.method = method;
globalThis.convert = convert;
globalThis.template = template;
globalThis.adapted = adapted;
globalThis.wrapped = wrapped;
globalThis.mixed = mixed;
const hostile = {
	[Symbol.toPrimitive]() {
		throw new Error("Unexpected coercion");
	},
};
for (const x of [
	undefined,
	null,
	false,
	true,
	0,
	-0,
	NaN,
	1,
	-1,
	"",
	"false",
	0n,
	1n,
	Symbol("x"),
	{},
	[],
	hostile,
]) {
	const expected = x ? "true" : "false";
	for (const f of [
		globalThis.method,
		globalThis.convert,
		globalThis.template,
		globalThis.adapted,
		globalThis.wrapped,
	]) {
		const value = f(x);
		if (value !== expected || typeof value !== "string")
			throw new Error("Boolean text mismatch");
		results.push(value);
	}
	results.push(globalThis.mixed(x));
}
const escaping = [];
for (let i = 0; i < 4096; i++) escaping[i % 64] = globalThis.template(i % 2);
results.push(escaping.join(","));
function capture(label, action) {
	try {
		const value = action();
		results.push([label, typeof value, value]);
	} catch (error) {
		results.push([label, "error", error.name]);
	}
}
for (const wrong of [undefined, null, 0, "false", {}, hostile, Symbol("x"), 1n])
	capture("wrong brand", () => Boolean.prototype.toString.call(wrong));
const box = new Boolean(false);
box.toString = () => {
	events.push("wrapper coercion");
	return "wrapper";
};
capture("wrapper String", () => String(box));
capture("wrapper template", () => `${box}`);
capture("wrapper internal data", () => Boolean.prototype.toString.call(box));
for (const boolean of [false, true]) {
	const coercible = {
		[Symbol.toPrimitive](hint) {
			events.push(hint);
			return boolean;
		},
	};
	capture("coerced Boolean String", () => String(coercible));
	capture("coerced Boolean template", () => `${coercible}`);
}
capture("Symbol implicit error", () => `${Symbol("x")}`);
capture("generic coercion error", () => String(hostile));
const originalMethod = Boolean.prototype.toString;
let changed = false;
try {
	Boolean.prototype.toString = () => "overridden";
	changed = Boolean.prototype.toString !== originalMethod;
} catch {}
if (changed) {
	if (globalThis.method(1) !== "overridden" || globalThis.adapted(1) !== "overridden")
		throw new Error("Lost method override");
	if (globalThis.template(1) !== "true")
		throw new Error("Implicit conversion consulted prototype");
	Boolean.prototype.toString = originalMethod;
} else {
	globalThis.method(1);
}
const OriginalString = String;
changed = false;
try {
	globalThis.String = () => "overridden";
	changed = String !== OriginalString;
} catch {}
if (changed) {
	if (globalThis.convert(1) !== "overridden") throw new Error("Lost String override");
	if (globalThis.template(1) !== "true")
		throw new Error("Implicit conversion consulted String");
	globalThis.String = OriginalString;
} else {
	globalThis.convert(1);
}
const OriginalBoolean = Boolean;
changed = false;
try {
	globalThis.Boolean = () => ({
		toString() {
			return "replacement";
		},
	});
	changed = Boolean !== OriginalBoolean;
} catch {}
if (changed) {
	if (globalThis.method(1) !== "replacement" || globalThis.convert(1) !== "replacement")
		throw new Error("Lost Boolean override");
	globalThis.Boolean = OriginalBoolean;
} else {
	globalThis.method(1);
	globalThis.convert(1);
}
capture("throwing String argument", () =>
	String(
		!!1,
		(() => {
			throw new RangeError();
		})(),
	),
);
capture("throwing method argument", () =>
	(!!1).toString(
		(() => {
			throw new RangeError();
		})(),
	),
);
console.log(JSON.stringify({ results, events }));
