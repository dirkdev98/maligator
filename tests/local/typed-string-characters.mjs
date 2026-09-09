const results = [],
	events = [];
function record(label, action) {
	try {
		const value = action();
		results.push([label, typeof value, value]);
	} catch (error) {
		results.push([label, "error", error.name]);
	}
}
const text = "a\ud83d\ude00b\ud800c\udc00z";
function cellCharAt(x) {
	return text.charAt(+x);
}
function cellAt(x) {
	return text.at(+x);
}
function cellPoint(x) {
	return text.codePointAt(+x);
}
function dynamicCharAt(s, x) {
	return String(s).charAt(+x);
}
function dynamicAt(s, x) {
	return String(s).at(+x);
}
function dynamicPoint(s, x) {
	return String(s).codePointAt(+x);
}
function makeRope(s) {
	return s.repeat(1024) + s.repeat(1024);
}
globalThis.makeRope = makeRope;
globalThis.cellCharAt = cellCharAt;
globalThis.cellAt = cellAt;
globalThis.cellPoint = cellPoint;
globalThis.dynamicCharAt = dynamicCharAt;
globalThis.dynamicAt = dynamicAt;
globalThis.dynamicPoint = dynamicPoint;
const positions = [
	-Infinity,
	-10,
	-2,
	-1,
	-0,
	0,
	1,
	1.9,
	2,
	3,
	4,
	5,
	6,
	7,
	8,
	Infinity,
	NaN,
];
for (const position of positions) {
	record("cellCharAt:" + position, () => globalThis.cellCharAt(position));
	record("cellAt:" + position, () => globalThis.cellAt(position));
	record("cellPoint:" + position, () => globalThis.cellPoint(position));
}
for (const sample of ["", "a", text, "\ud83d\ude00", "\ud800", "\udc00"]) {
	for (const position of positions) {
		record("dynamicCharAt", () => globalThis.dynamicCharAt(sample, position));
		record("dynamicAt", () => globalThis.dynamicAt(sample, position));
		record("dynamicPoint", () => globalThis.dynamicPoint(sample, position));
	}
	if (sample.length) {
		const lazy = globalThis.makeRope(sample);
		for (const position of [
			0,
			1,
			sample.length - 1,
			sample.length,
			lazy.length - 2,
			lazy.length - 1,
			lazy.length,
		]) {
			record("lazyCharAt", () => globalThis.dynamicCharAt(lazy, position));
			record("lazyAt", () => globalThis.dynamicAt(lazy, position));
			record("lazyPoint", () => globalThis.dynamicPoint(lazy, position));
		}
	}
}
if (results.some((row) => row[1] === "error"))
	throw new Error("Unexpected positive character failure");
function tdz(x) {
	return lateText.charAt(+x);
}
record("tdz-before", () => tdz(0));
const lateText = "ab";
record("tdz-after", () => tdz(0));
for (const method of ["charAt", "at", "codePointAt"]) {
	const call = (receiver, position) =>
		String.prototype[method].call(receiver, position, events.push("extra"));
	record(method + ":coercion-order", () =>
		call(
			{
				toString() {
					events.push("receiver");
					return text;
				},
			},
			{
				valueOf() {
					events.push("position");
					return 1;
				},
			},
		),
	);
	record(method + ":receiver-error", () =>
		call(
			{
				toString() {
					events.push("receiver-throws");
					throw new SyntaxError("receiver");
				},
			},
			{
				valueOf() {
					events.push("unreachable-position");
					return 1;
				},
			},
		),
	);
	record(method + ":position-error", () =>
		call(text, {
			valueOf() {
				events.push("position-throws");
				throw new RangeError("position");
			},
		}),
	);
	for (const receiver of [null, undefined, Symbol.iterator, {}, Object(text)])
		record(method + ":receiver", () => call(receiver, 1));
	for (const position of [1n, Symbol.iterator])
		record(method + ":position", () => call(text, position));
	const original = String.prototype[method];
	let changed = false;
	try {
		String.prototype[method] = () => "overridden";
		changed = String.prototype[method] !== original;
	} catch {}
	if (changed) {
		if (text[method](1) !== "overridden")
			throw new Error("Lost character prototype override");
		const fixed =
			method === "charAt"
				? globalThis.cellCharAt
				: method === "at"
					? globalThis.cellAt
					: globalThis.cellPoint;
		const dynamic =
			method === "charAt"
				? globalThis.dynamicCharAt
				: method === "at"
					? globalThis.dynamicAt
					: globalThis.dynamicPoint;
		if (fixed(1) !== "overridden" || dynamic(text, 1) !== "overridden")
			throw new Error("Typed character call bypassed a prototype override");
		String.prototype[method] = original;
	}
	record(method + ":restored", () => call(text, 1));
}
console.log(JSON.stringify(results));
console.log(JSON.stringify(events));
