import util from "node:util";

console.log("plain", 1, -0, 2n, true, null, undefined, Symbol("s"));
console.log(["a", "it's", 'say "hi" it\'s', "a\"b'c`d", "tab\tnew\nline\x01"]);
console.log([1, , 3, , , 6], new Array(3));
console.log(Array.from({ length: 30 }, (_, i) => i * 3));
console.log(Array.from({ length: 120 }, (_, i) => i));
console.log(Array.from({ length: 10 }, (_, i) => "s" + i));
const extra = [1, 2];
extra.label = "x";
console.log(extra);
const sym = Symbol("k");
console.log({
	a: 1,
	"b-c": 2,
	[sym]: 3,
	get g() {
		return 1;
	},
	set s(v) {},
	get gs() {
		return 1;
	},
	set gs(v) {},
});
console.log(Object.create(null), Object.assign(Object.create(null), { x: 1 }));
class Point {
	constructor() {
		this.x = 1;
		this.y = 2;
	}
}
class Empty {}
console.log(new Point(), new Empty(), [new Point()]);
console.log({ a: { b: { c: { d: 1 } } }, list: [[[[1]]]] });
const circular = { name: "root", child: {} };
circular.child.parent = circular;
circular.self = circular;
console.log(circular);
console.log({ alpha: "a".repeat(30), beta: "b".repeat(30), gamma: "c".repeat(30) });
console.log(
	new Map([
		["a", 1],
		[{ k: 1 }, [2]],
	]),
	new Set([1, "two"]),
	new Map(),
	new WeakMap(),
	new WeakSet(),
);
console.log(new Uint8Array([1, 2, 3]), new Float64Array(0), new Uint8Array(2).buffer);
console.log(new Date(0), new Date(NaN), /ab+c/gi);
const error = new Error("boom");
error.stack = "Error: boom";
error.code = "E_TEST";
console.log(error);
const framed = new TypeError("bad");
framed.stack = "TypeError: bad\n    at fixed (file.js:1:1)";
console.log(framed);
console.log(
	function named() {},
	() => {},
	class Base {},
	class Derived extends Point {},
);
console.log(
	async function af() {},
	function* gen() {},
	Math.max,
);
console.log(Promise.resolve(1), new Promise(() => {}), [
	Promise.reject(new Error("no")).catch(() => {}) && 1,
]);
console.log(new Number(3), new String("x"), new Boolean(false), Object(5n));
console.log(new Proxy({ target: true }, {}));
console.log(Buffer.from([1, 2, 255]));
console.log(
	{ [util.inspect.custom]: () => "CUSTOM" },
	{ [util.inspect.custom]: (depth, options) => ({ depth, colors: options.colors }) },
);
console.log(util.inspect({ a: [1, 2, { b: 3 }] }, { depth: 0 }));
console.log(util.inspect({ b: 1, a: 2 }, { sorted: true, compact: false }));
console.log(util.inspect({ x: [1, 2, 3] }, { breakLength: 3 }));
console.log(
	util.inspect("x".repeat(20), { maxStringLength: 5 }),
	util.inspect([1, 2, 3], { maxArrayLength: 1 }),
);
console.log(
	util.inspect(
		{
			get v() {
				return 7;
			},
		},
		{ getters: true },
	),
);
console.log(util.inspect({ s: "str", n: 1 }, { colors: true }));
console.log(util.inspect(new Map([[1, 2]]), { showHidden: true }));
console.log(
	util.inspect.defaultOptions.depth,
	typeof util.inspect.custom,
	util.inspect.styles.number,
);
console.log(
	util.format("%s|%d|%i|%f|%j|%%|%c.", "str", 42.5, 42.5, "3.5x", { j: 1 }, "css"),
);
console.log(
	util.format("%s %s %s %s", -0, 5n, [1, [2, [3]]], {
		toString() {
			return "T";
		},
	}),
);
const loop = {};
loop.loop = loop;
console.log(
	util.format("%j %o %O", loop, [1], { o: 1 }),
	util.format("100%%"),
	util.format("%s"),
	util.format(1, "a", { b: 2 }),
);
console.log(util.formatWithOptions({ colors: true }, "%O", 1));
console.log("%s and %d", "format", 7, "extra", { e: 1 });
console.dir(Buffer.from([1]));
console.dir({ deep: { deeper: { deepest: {} } } }, { depth: 0 });
console.group("Group");
console.log("inside");
console.group();
console.info({ nested: [1, 2] });
console.groupEnd();
console.groupEnd();
console.log("outside");
console.count();
console.count("x");
console.count();
console.countReset();
console.count();
console.table([{ a: 1, b: "x" }, { a: 22 }]);
console.table(["p", "q"]);
console.table(new Map([["k", { v: 1 }]]));
console.table(5);
console.assert(true, "never");
console.log({ err: framed, list: [error] });
console.log(Array.from({ length: 8 }, (_, i) => ({ a: i })));
console.log({
	text: "line one is here\nline two is also here and it is long enough to wrap\nthree",
});
console.log(
	{ 1: "a", valid_id: 2 },
	Object.assign(function withProps() {}, { a: 1 }),
);
class Tagged {
	get [Symbol.toStringTag]() {
		return "TagX";
	}
}
console.log(new Tagged(), [[new Map([[1, { a: { b: 1 } }]])]]);
console.log(util.inspect("a\nb".repeat(10)));
console.log(
	[undefined, null, NaN, Infinity, -1.5e300, 1e21, 0.1],
	[
		[1, 2],
		[3, 4],
	],
	{ a: [], b: {} },
);
console.log(
	new Set([[1, 2], { a: 1 }]),
	[new Set([1])],
	new Map([[new Map(), new Set()]]),
);
console.log(
	util.inspect({ a: { b: { c: { d: { e: 1 } } } } }, { depth: Infinity }),
	util.inspect({ a: { b: {} } }, { depth: null }),
);
