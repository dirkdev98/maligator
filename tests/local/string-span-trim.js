const gc = globalThis.__mal_collect_garbage;
const rows = [];
function collect() {
	if (typeof gc === "function") gc();
}
function observe(value) {
	collect();
	return `observed:${value}`;
}
function trimmed(value, first, second, effect, escape) {
	const token = value.trim(first, second);
	const size = token.length;
	effect();
	if (escape) return observe(token);
	return [
		size,
		Number(token),
		token === "12",
		token.charAt(0),
		token.at(-1),
		token.codePointAt(0),
		token.includes("1"),
	];
}
function templateObserver(value, effect) {
	const token = value.trim();
	const size = token.length;
	effect();
	return [size, `value:${token}`, token.length];
}
function evaluatedTrim(value, first, second) {
	const token = value.trim(first(), second());
	collect();
	return [token.length, token.charAt(0), token];
}
function leading(value, first, second, effect, escape) {
	const token = value.trimStart(first, second);
	const size = token.length;
	effect();
	if (escape) return observe(token);
	return [
		size,
		Number(token),
		token === "12",
		token.charAt(0),
		token.at(-1),
		token.codePointAt(0),
		token.includes("1"),
	];
}
function trailing(value, first, second, effect, escape) {
	const token = value.trimEnd(first, second);
	const size = token.length;
	effect();
	if (escape) return observe(token);
	return [
		size,
		Number(token),
		token === "12",
		token.charAt(0),
		token.at(-1),
		token.codePointAt(0),
		token.includes("1"),
	];
}
function range(value, effect, escape) {
	const outer = value.slice(1, -1);
	const token = outer.trim();
	const child = token.substring(0, 3);
	const leaf = child.trimEnd();
	effect();
	if (escape) return [observe(token), observe(outer)];
	return [leaf.length, leaf.charAt(0), leaf.startsWith("1"), Number(token), outer.length];
}
function split(value, effect, escape) {
	const outer = value.split("|")[1];
	if (outer === undefined) return "absent";
	const token = outer.trimStart();
	const child = token.trimEnd();
	effect();
	if (escape) return [observe(token), observe(outer)];
	return [child.length, child.at(-1), child.endsWith("2"), Number(child), outer.length];
}
function capture(regexp, value, effect, escape) {
	const match = regexp.exec(value);
	if (match === null) return ["miss", regexp.lastIndex];
	const outer = match[1];
	if (outer === undefined) return ["absent", regexp.lastIndex];
	const token = outer.trimEnd();
	const child = token.trimStart();
	effect();
	if (escape) return [observe(token), observe(outer), regexp.lastIndex];
	return [
		child.length,
		child.codePointAt(0),
		child.indexOf("2"),
		Number(child),
		outer.length,
		regexp.lastIndex,
	];
}
[" 12 ", "\ufeff😀\u2029", "\t\r\n", "\ud800 ", " \udc00", "  123 "].forEach((value) => {
	rows.push(
		trimmed(value, 1n, Symbol("ignored"), collect, false),
		leading(value, null, {}, collect, false),
		trailing(value, false, undefined, collect, false),
	);
	rows.push(
		range("x" + value + "z", collect, false),
		split("x|" + value + "|z", collect, false),
		capture(/\|([^|]*)\|/g, "x|" + value + "|z", collect, false),
	);
});
const spaces = [
	0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
	0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
	0xfeff, 0x85, 0x180e, 0x200b, 0x2060,
];
for (const code of spaces)
	for (const middle of ["", "12", "😀", "\ud800", "\udc00", "x y"])
		for (const escape of [false, true]) {
			const space = String.fromCharCode(code),
				value = space + middle + space;
			rows.push(
				trimmed(value, undefined, undefined, collect, escape),
				leading(value, undefined, undefined, collect, escape),
				trailing(value, undefined, undefined, collect, escape),
			);
			rows.push(
				range("x" + value + "z", collect, escape),
				split("x|" + value + "|z", collect, escape),
				capture(/\|([^|]*)\|/g, "x|" + value + "|z", collect, escape),
			);
		}
for (const value of ["", " ".repeat(300), " ".repeat(300) + "😀" + "\t".repeat(300)])
	rows.push(
		range("x" + value + "z", collect, true),
		split("x|" + value + "|z", collect, true),
		capture(/\|([^|]*)\|/g, "x|" + value + "|z", collect, true),
	);
rows.push(
	split("missing", collect, false),
	capture(/x(?:\|([^|]*)\|)?/g, "missing", collect, false),
	capture(/x(?:\|([^|]*)\|)?/g, "x", collect, false),
);
const events = [];
function ignored(label) {
	events.push(label);
	collect();
	return {
		valueOf() {
			throw new Error("ignored argument coerced");
		},
		toString() {
			throw new Error("ignored argument stringified");
		},
	};
}
rows.push(trimmed(" 12 ", ignored("first"), ignored("second"), collect, true), events);
rows.push(
	evaluatedTrim(
		" 12 ",
		() => ignored("call-first"),
		() => ignored("call-second"),
	),
	events,
);
for (const method of [trimmed, leading, trailing]) {
	const coercions = [];
	const boxed = new String(" 12 ");
	boxed.toString = function () {
		coercions.push("receiver");
		collect();
		return " 12 ";
	};
	rows.push(method(boxed, undefined, undefined, collect, true), coercions);
}
function retained(regexp, source) {
	let previous = "";
	const values = [];
	for (let i = 0; i < 3; i++) {
		const match = regexp.exec(source);
		if (match === null) break;
		const outer = match[1];
		const token = outer.trim();
		collect();
		values.push(previous, token.length);
		previous = token;
	}
	return [values, previous];
}
rows.push(retained(/\|([^|]*)\|/g, "| 1 || 22 || 333 |"));
if (process.env.MAL_SPAN_MUTABLE !== "locked") {
	for (const pair of [
		["trim", trimmed],
		["trimStart", leading],
		["trimEnd", trailing],
	]) {
		const [name, inspect] = pair,
			saved = Object.getOwnPropertyDescriptor(String.prototype, name),
			changes = [];
		Object.defineProperty(String.prototype, name, {
			configurable: true,
			get() {
				changes.push(String(this));
				collect();
				return saved.value;
			},
		});
		rows.push(inspect(" 12 ", undefined, undefined, collect, true), changes);
		rows.push(
			name === "trim"
				? range("x 12 z", collect, true)
				: name === "trimStart"
					? split("x| 12 |z", collect, true)
					: capture(/\|([^|]*)\|/g, "x| 12 |z", collect, true),
		);
		Object.defineProperty(String.prototype, name, saved);
		const receiver = new String(" 12 ");
		receiver.toString = function () {
			String.prototype[name] = () => "changed";
			changes.push("coerce");
			collect();
			return " 12 ";
		};
		rows.push(inspect(receiver, undefined, undefined, collect, true));
		rows.push(inspect(" 12 ", undefined, undefined, collect, true));
		Object.defineProperty(String.prototype, name, saved);
	}
	const savedStart = String.prototype.trimStart;
	String.prototype.trimStart = String.prototype.trimEnd;
	rows.push(leading(" 12 ", undefined, undefined, collect, true));
	String.prototype.trimStart = String.prototype.trimLeft;
	rows.push(leading(" 12 ", undefined, undefined, collect, true));
	String.prototype.trimStart = savedStart;
	const savedTrim = String.prototype.trim;
	const observerEvents = [];
	String.prototype.trim = function () {
		observerEvents.push("trim");
		return {
			get length() {
				observerEvents.push("length");
				collect();
				return 7;
			},
			toString() {
				observerEvents.push("string");
				collect();
				return "custom";
			},
		};
	};
	rows.push(templateObserver(" 12 ", collect), observerEvents);
	String.prototype.trim = savedTrim;

	rows.push(
		evaluatedTrim(
			" 12 ",
			() => {
				String.prototype.trim = () => "changed";
				collect();
				return Symbol("ignored");
			},
			() => ignored("captured-second"),
		),
	);
	rows.push(trimmed(" 12 ", undefined, undefined, collect, true));
	String.prototype.trim = savedTrim;
	const calls = [],
		savedExec = RegExp.prototype.exec;
	RegExp.prototype.exec = function (source) {
		calls.push(source);
		return savedExec.call(this, source);
	};
	rows.push(capture(/\|([^|]*)\|/g, "x| 12 |z", collect, true), calls);
	RegExp.prototype.exec = savedExec;
}
console.log(JSON.stringify(rows));
