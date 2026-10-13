const gc = globalThis.__mal_collect_garbage;
const rows = [];
function collect() {
	gc?.();
}
function observe(value) {
	collect();
	return `value:${value}`;
}
function range(source, start, count, needle, position, effect, escape) {
	const part = source.substr(start, count);
	const found = part.lastIndexOf(needle, position);
	effect();
	if (escape) return observe(part);
	return [found, part.length, part.charAt(0), part.at(-1), Number(part)];
}
function nested(source, needle, position, effect, escape) {
	const parent = source.slice(1, -1);
	const trimmed = parent.trim();
	const part = trimmed.substr(0, 80);
	const found = part.lastIndexOf(needle, position);
	effect();
	if (escape) return observe(part);
	return [found, part.length, parent.length, trimmed.length];
}
function split(source, needle, position, effect) {
	const part = source.split("|")[1];
	if (part === undefined) return "absent";
	const found = part.lastIndexOf(needle, position);
	effect();
	return [found, part.length];
}
function capture(regexp, source, needle, position, effect) {
	const match = regexp.exec(source);
	if (match === null) return ["miss", regexp.lastIndex];
	const part = match[1];
	if (part === undefined) return ["absent", regexp.lastIndex];
	const found = part.lastIndexOf(needle, position);
	effect();
	return [found, part.length, regexp.lastIndex];
}
function splitSubstr(source) {
	const parent = source.split("|")[1];
	if (parent === undefined) return "absent";
	const part = parent.substr(-4, 3);
	collect();
	return [part.lastIndexOf("a"), part.length, parent.length, observe(part)];
}
function captureSubstr(source) {
	const match = /\|([^|]*)\|/.exec(source);
	if (match === null) return "miss";
	const parent = match[1];
	const part = parent.substr(-4, 3);
	collect();
	return [part.lastIndexOf("a"), part.length, parent.length, observe(part)];
}
["x|ababa|z", "x|😀a\ud800|z", "x||z"].forEach((source) => {
	rows.push(range(source, 1, 7, "a", Infinity, collect, false));
	rows.push(nested(source, "a", Infinity, collect, false));
	rows.push(split(source, "a", Infinity, collect));
	rows.push(capture(/\|([^|]*)\|/g, source, "a", Infinity, collect));
	rows.push(splitSubstr(source), captureSubstr(source));
});
const words = [
	"",
	"a",
	"ababa",
	"😀a😀",
	"\ud800a\udc00",
	"undefined",
	"12",
	"a".repeat(100) + "b" + "a".repeat(100),
];
const positions = [
	undefined,
	NaN,
	-Infinity,
	Infinity,
	-0,
	-4.7,
	-1,
	0,
	0.9,
	1.8,
	7,
	1000,
];
for (const word of words) {
	for (const position of positions) {
		for (const needle of ["", "a", "aa", "b", "😀", "\ud800", "\udc00", "a".repeat(33)]) {
			rows.push(
				range("x" + word + "z", 1, word.length, needle, position, collect, false),
			);
			rows.push(nested("x " + word + " z", needle, position, collect, false));
			rows.push(split("x|" + word + "|z", needle, position, collect));
			rows.push(capture(/\|([^|]*)\|/g, "x|" + word + "|z", needle, position, collect));
		}
	}
	for (const start of positions)
		for (const count of positions)
			rows.push(range(word, start, count, "a", undefined, collect, true));
}
function omitted(source) {
	const part = source.substr();
	collect();
	return [part.lastIndexOf(), part.lastIndexOf(""), part.length];
}
rows.push(omitted("undefined"), omitted(""));
rows.push(
	split("missing", "a", 0, collect),
	capture(/never/g, "missing", "a", 0, collect),
	capture(/x(a)?/g, "x", "a", 0, collect),
);
const events = [];
const needle = {
	get [Symbol.match]() {
		throw new Error("Symbol.match must not be read");
	},
	toString() {
		events.push("needle");
		collect();
		return "a";
	},
};
const position = {
	valueOf() {
		events.push("position");
		collect();
		return 2.9;
	},
};
rows.push(range("xabaz", 1, 3, needle, position, collect, false), events.slice());
const regex = /a/;
Object.defineProperty(regex, Symbol.match, {
	get() {
		throw new Error("regexp Symbol.match must not be read");
	},
});
regex.toString = () => {
	events.push("regexp-string");
	return "a";
};
rows.push(range("xabaz", 1, 3, regex, undefined, collect, false));
for (const argument of [undefined, null, true, 17, 1n, Symbol("needle")]) {
	try {
		rows.push(range("xundefinedz", 1, 9, argument, 0, collect, false));
	} catch (error) {
		rows.push(error.name);
	}
}
for (const bound of [null, true, "2", 1n, Symbol("bound")]) {
	try {
		rows.push(range("xabaz", bound, 2, "a", undefined, collect, true));
	} catch (error) {
		rows.push(error.name);
	}
}
const boxed = new String("ababa");
boxed.toString = () => {
	events.push("receiver");
	collect();
	return "ababa";
};
rows.push(
	range(
		boxed,
		{
			valueOf() {
				events.push("start");
				collect();
				return -4;
			},
		},
		{
			valueOf() {
				events.push("count");
				collect();
				return 3;
			},
		},
		"a",
		Infinity,
		collect,
		true,
	),
);
try {
	range(
		boxed,
		{
			valueOf() {
				events.push("start-throw");
				throw new RangeError("start");
			},
		},
		{
			valueOf() {
				events.push("wrong-count");
				return 3;
			},
		},
		"a",
		0,
		collect,
		false,
	);
} catch (error) {
	rows.push(error.name);
}
rows.push(events);
function retained(regexp, source) {
	const out = [];
	let previous = "";
	for (let index = 0; index < 3; index++) {
		const match = regexp.exec(source);
		const token = match[1].substr(0, 8);
		collect();
		out.push(previous, token.lastIndexOf("a"));
		previous = token;
	}
	return [out, previous, regexp.lastIndex];
}
rows.push(retained(/\|([^|]*)\|/g, "|a||aba||aaa|"));
if (process.env.MAL_SPAN_MUTABLE !== "locked") {
	for (const method of ["substr", "lastIndexOf"]) {
		const saved = Object.getOwnPropertyDescriptor(String.prototype, method),
			trace = [];
		Object.defineProperty(String.prototype, method, {
			configurable: true,
			get() {
				trace.push(String(this));
				collect();
				return saved.value;
			},
		});
		rows.push(
			range("xabaz", 1, 3, "a", Infinity, collect, true),
			nested("x aba z", "a", Infinity, collect, false),
			trace,
		);
		Object.defineProperty(String.prototype, method, saved);
	}
	const saved = String.prototype.lastIndexOf,
		trace = [];
	const changingNeedle = {
		toString() {
			trace.push("needle");
			String.prototype.lastIndexOf = () => -71;
			collect();
			return "a";
		},
	};
	rows.push(range("xabaz", 1, 3, changingNeedle, Infinity, collect, false));
	rows.push(range("xabaz", 1, 3, "a", Infinity, collect, false));
	String.prototype.lastIndexOf = () => ({ kind: "override" });
	rows.push(range("xabaz", 1, 3, "a", Infinity, collect, false));
	String.prototype.lastIndexOf = saved;
	const substr = String.prototype.substr;
	const start = {
		valueOf() {
			trace.push("start");
			String.prototype.substr = () => "changed";
			collect();
			return 1;
		},
	};
	rows.push(range("xabaz", start, 3, "a", Infinity, collect, true));
	rows.push(range("xabaz", 1, 3, "a", Infinity, collect, true));
	String.prototype.substr = substr;
	String.prototype.substr = String.prototype.substring;
	rows.push(range("xabaz", -3, 2, "a", Infinity, collect, true));
	String.prototype.substr = () => ({
		lastIndexOf() {
			trace.push("custom-search");
			collect();
			return 19;
		},
		toString() {
			trace.push("custom-string");
			collect();
			return "custom";
		},
	});
	rows.push(range("xabaz", 1, 3, "a", Infinity, collect, true));
	String.prototype.substr = substr;
	const regexp = /\|([^|]*)\|/g,
		exec = regexp.exec;
	regexp.exec = function (value) {
		trace.push("exec");
		collect();
		return exec.call(this, value);
	};
	rows.push(capture(regexp, "x|aba|z", "a", Infinity, collect), trace);
}
console.log(JSON.stringify(rows));
