// Leaf fast paths finish instanceof, in, Number coercions, string code unit reads and
// short loops; every input they decline must reach the full operation unchanged.
const log = [];

function record(label, read) {
	try {
		log.push(`${label}: ${String(read())}`);
	} catch (error) {
		log.push(`${label}: ${error.constructor.name}`);
	}
}

function isInstance(value, target) {
	return value instanceof target;
}

function hasKey(key, object) {
	return key in object;
}

function notNumber(value) {
	return isNaN(value);
}

function finite(value) {
	return isFinite(value);
}

function toNumber(value) {
	return Number(value);
}

// Captured constants keep the scanners off typed loop regions, as in header parsers, and
// an extra ignored argument keeps charCodeAt off the call-chain region; both regions
// replace the whole body, which would leave these functions without a leaf fast path.
const { codeAt, codeAtStart, unitAt, startsWithSlash, skipSpaces, trimEnd } = (() => {
	const SPACE = 32;
	const TAB = 9;
	const SLASH = "/";

	function codeAt(text, index) {
		return text.charCodeAt(index, TAB);
	}

	function codeAtStart(text) {
		return text.charCodeAt(undefined, TAB);
	}

	function unitAt(text, index) {
		return text[index];
	}

	function startsWithSlash(text) {
		return typeof text === "string" && text.length !== 0 && text[0] === SLASH;
	}

	function skipSpaces(text, index, end) {
		while (index < end) {
			const code = text.charCodeAt(index, end);
			if (code !== SPACE && code !== TAB) break;
			index++;
		}
		return index;
	}

	function trimEnd(text, start, end) {
		while (end > start) {
			const code = text.charCodeAt(end - 1, start);
			if (code !== SPACE && code !== TAB) break;
			end--;
		}
		return end;
	}

	return { codeAt, codeAtStart, unitAt, startsWithSlash, skipSpaces, trimEnd };
})();

function findInstance(items, target) {
	for (let index = 0; index < items.length; index++)
		if (items[index] instanceof target) return index;
	return -1;
}

function hasAllKeys(object, keys) {
	for (let index = 0; index < keys.length; index++)
		if (!(keys[index] in object)) return false;
	return true;
}

function countDown(count) {
	while (count > 0) count = count - 1;
	return count;
}

function hasBody(headers) {
	return headers["transfer-encoding"] !== undefined || !isNaN(headers["content-length"]);
}

// Repeated calls fill the inline caches the fast paths read.
function warm(read) {
	let last;
	for (let round = 0; round < 40; round++) last = read();
	return last;
}

function Point(x) {
	this.x = x;
}
class Shape {}
class Square extends Shape {}
const point = new Point(1);
record("instance", () => warm(() => isInstance(point, Point)));
record("other instance", () => warm(() => isInstance({}, Point)));
record("primitive left", () => warm(() => isInstance(1, Point)));
record("null prototype left", () => warm(() => isInstance(Object.create(null), Point)));
record("class", () => warm(() => isInstance(new Square(), Shape)));
record("derived class", () => warm(() => isInstance(new Square(), Square)));
record("native constructor", () => warm(() => isInstance([], Array)));
record("non-callable right", () => isInstance(point, {}));
record("primitive right", () => isInstance(point, 1));
record("arrow right", () => isInstance(point, () => {}));
record("method right", () => isInstance(point, Math.max));
function NumberPrototype() {}
NumberPrototype.prototype = 1;
record("non-object prototype", () => isInstance(point, NumberPrototype));
function Replaced() {}
Replaced.prototype = Point.prototype;
record("replaced prototype", () => warm(() => isInstance(point, Replaced)));
function Lazy() {}
record("lazy prototype", () => isInstance(point, Lazy));
record("lazy prototype created", () => isInstance(new Lazy(), Lazy));
const bound = Point.bind(null);
record("bound right", () => warm(() => isInstance(point, bound)));
function Custom() {}
Object.defineProperty(Custom, Symbol.hasInstance, {
	value(value) {
		log.push("own hasInstance");
		return value === 7;
	},
});
record("own hasInstance", () => isInstance(7, Custom));
class Inherits {
	static [Symbol.hasInstance](value) {
		log.push("static hasInstance");
		return typeof value === "string";
	}
}
class InheritsChild extends Inherits {}
record("inherited hasInstance", () => isInstance("text", InheritsChild));
function Reparented() {}
Object.setPrototypeOf(Reparented, Object.prototype);
record("reparented right", () => isInstance(new Reparented(), Reparented));
const trapped = new Proxy(new Point(2), {
	getPrototypeOf(target) {
		log.push("getPrototypeOf trap");
		return Reflect.getPrototypeOf(target);
	},
});
record("proxy left", () => isInstance(trapped, Point));
const behindProxy = Object.create(
	new Proxy(Point.prototype, {
		getPrototypeOf(target) {
			log.push("chain getPrototypeOf trap");
			return Reflect.getPrototypeOf(target);
		},
	}),
);
record("proxy in chain", () => isInstance(behindProxy, Shape));
const proxyRight = new Proxy(Point, {
	get(target, key, receiver) {
		log.push(`get trap ${String(key)}`);
		return Reflect.get(target, key, receiver);
	},
});
record("proxy right", () => isInstance(point, proxyRight));
let deep = new Point(3);
for (let depth = 0; depth < 100; depth++) deep = Object.create(deep);
record("deep chain", () => warm(() => isInstance(deep, Point)));
record("deep chain miss", () => warm(() => isInstance(deep, Shape)));

const keyed = {
	own: 1,
	get accessor() {
		log.push("accessor getter");
		return 2;
	},
};
const child = Object.create(keyed);
record("own key", () => warm(() => hasKey("own", keyed)));
record("accessor key", () => warm(() => hasKey("accessor", keyed)));
record("inherited key", () => warm(() => hasKey("own", child)));
record("absent key", () => warm(() => hasKey("missing", child)));
record("array index", () => warm(() => hasKey(1, [1, 2])));
record("symbol key", () => warm(() => hasKey(Symbol.iterator, [])));
record("primitive object", () => hasKey("length", "text"));
const hasTrap = new Proxy(
	{},
	{
		has(target, key) {
			log.push(`has trap ${String(key)}`);
			return key === "seen";
		},
	},
);
record("proxy has", () => hasKey("seen", hasTrap));
record("key object", () =>
	hasKey(
		{
			toString() {
				log.push("key toString");
				return "own";
			},
		},
		keyed,
	),
);
child.added = 3;
record("added key", () => hasKey("added", child));

const numberInputs = [
	"",
	" ",
	"12",
	"  12  ",
	"\t\n\v\f\r        　﻿7",
	"0x10",
	"0X1f",
	"-0x10",
	"0b101",
	"0o17",
	"Infinity",
	"-Infinity",
	"+Infinity",
	"infinity",
	"+5",
	"-5",
	"1e3",
	".5",
	"5.",
	"1_000",
	"abc",
	"12px",
	"-0",
	"٠",
	0,
	-0,
	1.5,
	NaN,
	Infinity,
	undefined,
	null,
	true,
	false,
];
for (const input of numberInputs) {
	const label = typeof input === "string" ? JSON.stringify(input) : String(input);
	record(`isNaN ${label}`, () => warm(() => notNumber(input)));
	record(`isFinite ${label}`, () => warm(() => finite(input)));
	record(`Number ${label}`, () => {
		const result = warm(() => toNumber(input));
		return Object.is(result, -0) ? "-0" : result;
	});
}
const valued = {
	valueOf() {
		log.push("valueOf");
		return "4";
	},
};
record("isNaN object", () => notNumber(valued));
record("isFinite object", () => finite(valued));
record("Number object", () => toNumber(valued));
record("isNaN symbol", () => notNumber(Symbol("s")));
record("Number symbol", () => toNumber(Symbol("s")));
record("isNaN bigint", () => notNumber(1n));
record("Number bigint", () => toNumber(12n));
record("hasBody get", () => warm(() => hasBody({})));
record("hasBody length", () => warm(() => hasBody({ "content-length": "42" })));
record("hasBody empty length", () => warm(() => hasBody({ "content-length": "" })));
record("hasBody text length", () => warm(() => hasBody({ "content-length": "abc" })));
record("hasBody chunked", () => warm(() => hasBody({ "transfer-encoding": "chunked" })));

let rope = "";
for (let index = 0; index < 40; index++) rope += String.fromCharCode(97 + (index % 26));
const wide = "aé€😀z";
const slice = `  padded value  `.substring(1, 12);
const textInputs = [
	["flat", "header"],
	["rope", rope],
	["slice", slice],
	["wide", wide],
	["empty", ""],
];
const indices = [
	0,
	1,
	3,
	4,
	5,
	-1,
	1.5,
	0.9,
	-0.5,
	NaN,
	Infinity,
	-Infinity,
	-0,
	100,
	undefined,
	"1",
	null,
	true,
];
for (const [name, text] of textInputs) {
	for (const index of indices) {
		const label = typeof index === "string" ? JSON.stringify(index) : String(index);
		record(`codeAt ${name} ${label}`, () => warm(() => codeAt(text, index)));
		record(`unitAt ${name} ${label}`, () => warm(() => unitAt(text, index)));
	}
	record(`codeAtStart ${name}`, () => warm(() => codeAtStart(text)));
	record(`skipSpaces ${name}`, () => warm(() => skipSpaces(text, 0, text.length)));
	record(`trimEnd ${name}`, () => warm(() => trimEnd(text, 0, text.length)));
}
const spaces = `${" ".repeat(300)}x${"\t".repeat(300)}`;
record("skipSpaces long", () => warm(() => skipSpaces(spaces, 0, spaces.length)));
record("trimEnd long", () => warm(() => trimEnd(spaces, 0, spaces.length)));
record("skipSpaces numeric string index", () => skipSpaces("  x", "0", 3));
record("startsWithSlash", () => warm(() => startsWithSlash("/users")));
record("startsWithSlash relative", () => warm(() => startsWithSlash("users")));
record("startsWithSlash wide", () => warm(() => startsWithSlash("€/")));
record("codeAt string object", () => codeAt(new String("abc"), 1));
record("codeAt number receiver", () => codeAt(12, 0));
record("codeAt null receiver", () => codeAt(null, 0));
record("codeAt index object", () =>
	codeAt("abc", {
		valueOf() {
			log.push("index valueOf");
			return 2;
		},
	}),
);
record("unitAt string object", () => unitAt(new String("abc"), 1));
Object.defineProperty(String.prototype, 7, {
	configurable: true,
	get() {
		log.push("String.prototype[7] getter");
		return "inherited";
	},
});
record("unitAt inherited index", () => unitAt("abc", 7));
record("unitAt own index", () => unitAt("abcdefghij", 7));
delete String.prototype[7];

const mixed = [1, "two", null, {}, [], point];
record("findInstance", () => warm(() => findInstance(mixed, Point)));
record("findInstance missing", () => warm(() => findInstance(mixed, Shape)));
const many = Array.from({ length: 300 }, (_, index) =>
	index === 250 ? new Square() : index,
);
record("findInstance long", () => warm(() => findInstance(many, Shape)));
record("findInstance proxy element", () => findInstance([1, trapped], Point));
record("hasAllKeys", () => warm(() => hasAllKeys(keyed, ["own", "accessor"])));
record("hasAllKeys missing", () => warm(() => hasAllKeys(child, ["own", "missing"])));
record("hasAllKeys proxy", () => hasAllKeys(hasTrap, ["seen", "other"]));
record("countDown", () => warm(() => countDown(10)));
record("countDown long", () => warm(() => countDown(1000)));
record("countDown fraction", () => warm(() => countDown(2.5)));
record("countDown string", () => countDown("3"));

const original = String.prototype.charCodeAt;
String.prototype.charCodeAt = function (index) {
	log.push(`replaced charCodeAt ${index}`);
	return 32;
};
record("replaced codeAt", () => codeAt("abc", 0));
record("replaced skipSpaces", () => skipSpaces("abc", 0, 3));
String.prototype.charCodeAt = original;
record("restored codeAt", () => warm(() => codeAt("abc", 0)));

if (globalThis.gc) globalThis.gc();
console.log(log.join("\n"));
