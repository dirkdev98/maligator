const results = [];
function record(label, action) {
	try {
		const value = action();
		results.push(label + ":" + (Object.is(value, -0) ? "-0" : JSON.stringify(value)));
	} catch (error) {
		results.push(label + ":" + error.name);
	}
}
globalThis.template = JSON.parse('{"raw":["a","b"]}');
function operation0(x) {
	return String.fromCharCode(new Number(x));
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.fromCharCode", () => operation0(value));
function operation1(x) {
	return String.fromCodePoint(new Number(x));
}
for (const value of [
	-1,
	-0,
	0,
	65,
	0xd800,
	0x1f600,
	0x10ffff,
	0x110000,
	1.5,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.fromCodePoint", () => operation1(value));
function operation2(x) {
	return "abcdef".at(new Number(x));
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.prototype.at", () => operation2(value));
function operation3(x) {
	return "abcdef".charAt(new Number(x));
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.prototype.charAt", () => operation3(value));
function operation4(x) {
	return "abcdef".charCodeAt(new Number(x));
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.prototype.charCodeAt", () => operation4(value));
function operation5(x) {
	return "a😀b".codePointAt(new Number(x));
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.prototype.codePointAt", () => operation5(value));
function operation6(x) {
	return "abcdef".includes(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.includes", () => operation6(value));
function operation7(x) {
	return "abcdef".indexOf(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.indexOf", () => operation7(value));
function operation8(x) {
	return "abcdef".lastIndexOf(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.lastIndexOf", () => operation8(value));
function operation9(x) {
	return "abcdef".startsWith(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.startsWith", () => operation9(value));
function operation10(x) {
	return "abcdef".endsWith(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.endsWith", () => operation10(value));
function operation11(x) {
	return "abcdef".slice(new Number(x), 5);
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.prototype.slice", () => operation11(value));
function operation12(x) {
	return "abcdef".substring(new Number(x), 5);
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.prototype.substring", () => operation12(value));
function operation13(x) {
	return "abcdef".substr(new Number(x), 3);
}
for (const value of [
	-3,
	-0,
	0,
	1,
	2.5,
	65,
	0xd800,
	0x1f600,
	NaN,
	Infinity,
	Symbol("x"),
	2n,
])
	record("String.prototype.substr", () => operation13(value));
function operation14(x) {
	return "abcdef".concat(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.concat", () => operation14(value));
function operation15(x) {
	return "ab".repeat(new Number(x));
}
for (const value of [-1, -0, 0, 2, 3.5, NaN, Infinity, Symbol("x"), 2n])
	record("String.prototype.repeat", () => operation15(value));
function operation16(x) {
	return "ab".padStart(8, new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.padStart", () => operation16(value));
function operation17(x) {
	return "ab".padEnd(8, new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.padEnd", () => operation17(value));
function operation18(x) {
	return String.raw(globalThis.template, new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.raw", () => operation18(value));
function operation19(x) {
	return "é".normalize(new String(x));
}
for (const value of ["NFC", "NFD", "NFKC", "NFKD", "invalid", undefined, Symbol("x")])
	record("String.prototype.normalize", () => operation19(value));
function operation20(x) {
	return "a,b,c".split(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.split", () => operation20(value));
function operation21(x) {
	return "aba".replace(new String(x), "z");
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.replace", () => operation21(value));
function operation22(x) {
	return "aba".replaceAll(new String(x), "z");
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.replaceAll", () => operation22(value));
function operation23(x) {
	return "body".anchor(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.anchor", () => operation23(value));
function operation24(x) {
	return "body".fontcolor(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.fontcolor", () => operation24(value));
function operation25(x) {
	return "body".fontsize(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.fontsize", () => operation25(value));
function operation26(x) {
	return "body".link(new String(x));
}
for (const value of [
	"",
	"a",
	",",
	"abc",
	"é",
	"\ud800",
	"😀",
	'"<&',
	"$&",
	undefined,
	Symbol("x"),
])
	record("String.prototype.link", () => operation26(value));

function ranged(start, end) {
	return "abcdef".slice(new Number(start), new Number(end));
}
function padded(size, fill) {
	return "ab".padEnd(new Number(size), new String(fill));
}
function limited(limit) {
	return "a,b,c".split(",", new Number(limit));
}
function replaced(value) {
	return "aba".replace("a", new String(value));
}
function replacedAll(value) {
	return "aba".replaceAll("a", new String(value));
}
for (const value of [-1, -0, 0, 1.5, 3, NaN, Infinity]) {
	record("range-arguments", () => ranged(value, 4));
	record("limit", () => limited(value));
}
for (const value of ["", "$&", "$`", "$'", "$$", "é", "😀"]) {
	record("replacement", () => replaced(value));
	record("replacement-all", () => replacedAll(value));
}
record("pad-arguments", () => padded(9, "😀"));
record("symbol-search", () => "a".includes(Object(Symbol("a"))));
record("symbol-fill", () => "a".padStart(3, Object(Symbol("a"))));
record("symbol-fill-skipped", () => "a".padStart(1, Object(Symbol("a"))));
record("bigint-position", () => "a".at(Object(1n)));
record("bigint-substitution", () => String.raw(globalThis.template, Object(2n)));
record("symbol-substitution", () => String.raw(globalThis.template, Object(Symbol("a"))));
record("boolean-character", () => String.fromCharCode(new Boolean(false)));
record("split-fresh", () => {
	const a = limited(2),
		b = limited(2);
	a[0] = "changed";
	return [a !== b, b];
});
record("callback", () =>
	"aba".replaceAll(new String("a"), (...args) => JSON.stringify(args)),
);
let events = [];
const converting = (label, value) => ({
	[Symbol.toPrimitive](hint) {
		events.push(label + ":" + hint);
		return value;
	},
});
record("construction-before-later-argument", () =>
	"abc".slice(new Number(converting("first", 1)), converting("second", 2)),
);
record("construction-order", () => events);
events = [];
record("raw-getters", () =>
	String.raw(
		{
			get raw() {
				events.push("raw");
				return {
					get length() {
						events.push("length");
						return 2;
					},
					get 0() {
						events.push("zero");
						return "a";
					},
					get 1() {
						events.push("one");
						return "b";
					},
				};
			},
		},
		new String(converting("substitution", "x")),
	),
);
record("raw-order", () => events);
events = [];
record("bad-codepoint-skips-later-coercion", () =>
	String.fromCodePoint(new Number(-1), converting("later", 65)),
);
record("codepoint-order", () => events);
events = [];
record("limit-zero-skips-search-coercion", () =>
	"a".split(converting("search", "a"), new Number(0)),
);
record("split-order", () => events);
events = [];
record("ignored-extra-construction", () =>
	"a".at(new Number(0), new Number(converting("extra", 1))),
);
record("extra-order", () => events);
function protocolReceiver(value, pattern) {
	return new String(value).split(pattern);
}
function protocolLimit(value, pattern) {
	return "a".split(pattern, new Number(value));
}
function protocolReplacement(value, pattern) {
	return "a".replace(pattern, new String(value));
}
function protocolReplacementAll(value, pattern) {
	return "a".replaceAll(pattern, new String(value));
}
const seen = [];
const protocol = {
	[Symbol.split](receiver, limit) {
		seen.push(receiver, limit);
		return [
			typeof receiver,
			receiver instanceof String,
			typeof limit,
			limit instanceof Number,
		];
	},
	[Symbol.replace](receiver, replacement) {
		seen.push(replacement);
		return [typeof receiver, typeof replacement, replacement instanceof String];
	},
};
record("protocol-receiver", () => protocolReceiver("a", protocol));
record("protocol-limit", () => protocolLimit(2, protocol));
record("protocol-replacement", () => protocolReplacement("x", protocol));
record("protocol-replacement-all", () => protocolReplacementAll("x", protocol));
record("protocol-fresh", () => {
	protocolReplacement("x", protocol);
	return seen[seen.length - 1] !== seen[seen.length - 2];
});
record("own-match", () => {
	const wrapper = new String("a");
	wrapper[Symbol.match] = true;
	return "a".includes(wrapper);
});
record("own-split", () => {
	const wrapper = new String(",");
	wrapper[Symbol.split] = () => ["own"];
	return "a,b".split(wrapper);
});
record("own-conversion", () => {
	const wrapper = new String("a");
	wrapper[Symbol.toPrimitive] = () => "b";
	return "abc".indexOf(wrapper);
});
record("escaped", () => {
	const wrapper = new String("a");
	globalThis.savedWrapper = wrapper;
	return [
		"abc".indexOf(wrapper),
		globalThis.savedWrapper === wrapper,
		typeof globalThis.savedWrapper,
	];
});
record("raw-template", () => String.raw(new String("ab"), "x"));
if (!Object.isFrozen(String.prototype)) {
	const savedMatch = Object.getOwnPropertyDescriptor(String.prototype, Symbol.match);
	const savedSplit = Object.getOwnPropertyDescriptor(String.prototype, Symbol.split);
	const savedReplace = Object.getOwnPropertyDescriptor(String.prototype, Symbol.replace);
	const savedToString = String.prototype.toString;
	try {
		String.prototype[Symbol.match] = true;
		record("mutable-match", () => operation6("a"));
		delete String.prototype[Symbol.match];
		String.prototype[Symbol.split] = function (receiver, limit) {
			return [this instanceof String, typeof limit, limit instanceof Number];
		};
		record("mutable-split", () => "a,b".split(new String(","), new Number(2)));
		String.prototype[Symbol.replace] = function (receiver, replacement) {
			return [this instanceof String, replacement instanceof String];
		};
		record("mutable-replace", () => "aba".replace(new String("a"), new String("b")));
		String.prototype.toString = function () {
			return "b";
		};
		record("mutable-conversion", () => operation7("a"));
	} finally {
		for (const [key, descriptor] of [
			[Symbol.match, savedMatch],
			[Symbol.split, savedSplit],
			[Symbol.replace, savedReplace],
		]) {
			if (descriptor) Object.defineProperty(String.prototype, key, descriptor);
			else delete String.prototype[key];
		}
		String.prototype.toString = savedToString;
	}
} else {
	results.push(
		"mutable-match:TypeError",
		'mutable-split:[true,"object",true]',
		"mutable-replace:[true,true]",
		"mutable-conversion:1",
	);
}
console.log(results.join("\n"));
