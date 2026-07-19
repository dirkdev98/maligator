// Headers Fetch/WinterTC semantics acceptance fixture. Run via:
//   node scripts/webtest.ts tests/local/headers_iter.js

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

function rejectsTypeError(fn) {
	try {
		fn();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}

let getterCalls = 0;
const h = new Headers({
	"X-Z": " \t z \t ",
	get "X-Num"() {
		getterCalls++;
		return 42;
	},
});
class DerivedHeaders extends Headers {}
const derived = new DerivedHeaders([["X-Derived", "yes"]]);
let constructionOrder = "";
const orderedInit = {};
Object.defineProperty(orderedInit, Symbol.iterator, {
	get() {
		constructionOrder += "i";
		return function () {
			return [][Symbol.iterator]();
		};
	},
});
const NewTargetBase = function () {};
const NewTarget = new Proxy(NewTargetBase, {
	get(target, key, receiver) {
		if (key === "prototype") constructionOrder += "p";
		return Reflect.get(target, key, receiver);
	},
});
const reflected = Reflect.construct(Headers, [orderedInit], NewTarget);
check(
	"constructor requires new",
	rejectsTypeError(() => Headers()),
);
check(
	"subclass construction honors newTarget prototype",
	derived instanceof DerivedHeaders && derived.get("x-derived") === "yes",
);
check(
	"Reflect.construct honors newTarget prototype",
	Object.getPrototypeOf(reflected) === NewTargetBase.prototype,
);
check("prototype lookup precedes HeadersInit", constructionOrder === "pi");
check(
	"record getters, coercion, lowercase names, and value trimming",
	getterCalls === 1 && h.get("X-Z") === "z" && h.get("x-num") === "42",
);

h.append("X-A", "1");
h.append("x-a", 2);
h.append("Set-Cookie", "a=1");
h.append("set-cookie", "b=2");
check("get combines duplicate values", h.get("X-A") === "1, 2");
check("get combines Set-Cookie for compatibility", h.get("set-cookie") === "a=1, b=2");
check("getSetCookie preserves separate values", h.getSetCookie().join("|") === "a=1|b=2");

const initializedDuplicates = new Headers([
	["X-Duplicate", "one"],
	["x-duplicate", "two"],
	["Set-Cookie", "c=3"],
	["set-cookie", "d=4"],
]);
check(
	"sequence initialization preserves duplicate and Set-Cookie values",
	initializedDuplicates.get("x-duplicate") === "one, two" &&
		initializedDuplicates.getSetCookie().join("|") === "c=3|d=4" &&
		[...initializedDuplicates].length === 3,
);

check(
	"normalization strips edge HTTP whitespace before validation",
	new Headers([["x", "\r\n \tvalue\t \r\n"]]).get("x") === "value" &&
		new Headers([["x", "\r\n"]]).get("x") === "" &&
		rejectsTypeError(() => new Headers([["x", "a\rb"]])),
);

let entries = "";
for (const [name, value] of h.entries()) entries += `${name}=${value};`;
check(
	"entries lowercases, sorts, combines, and preserves Set-Cookie",
	entries === "set-cookie=a=1;set-cookie=b=2;x-a=1, 2;x-num=42;x-z=z;",
);

let defaultEntries = "";
for (const [name, value] of h) defaultEntries += `${name}=${value};`;
check(
	"default iterator is entries",
	Headers.prototype[Symbol.iterator] === Headers.prototype.entries &&
		defaultEntries === entries,
);
check(
	"keys use the sorted combined view",
	[...h.keys()].join("|") === "set-cookie|set-cookie|x-a|x-num|x-z",
);
check(
	"values use the sorted combined view",
	[...h.values()].join("|") === "a=1|b=2|1, 2|42|z",
);
check(
	"spread and Array.from consume Headers iterators",
	[...h].length === 5 && Array.from(h).length === 5,
);

const live = new Headers({ "x-a": "1" });
const iterator = live.entries();
live.append("x-z", "2");
const first = iterator.next();
live.append("x-z", "3");
const second = iterator.next();
check(
	"iterator is live",
	iterator[Symbol.iterator]() === iterator &&
		first.value.join("=") === "x-a=1" &&
		second.value.join("=") === "x-z=2, 3" &&
		iterator.next().done,
);

const forEachHeaders = new Headers({ b: "2", a: "1" });
const thisArg = { marker: "ok" };
let forEachResult = "";
forEachHeaders.forEach(function (value, name, owner) {
	forEachResult += `${name}=${value};`;
	if (name === "a") owner.append("z", "3");
	check("forEach thisArg", this === thisArg);
}, thisArg);
check("forEach is sorted, live, and passes owner", forEachResult === "a=1;b=2;z=3;");

const setHeaders = new Headers();
setHeaders.append("X", "1");
setHeaders.append("x", "2");
setHeaders.set("X", " 3 ");
check(
	"set replaces all duplicates",
	setHeaders.get("x") === "3" && [...setHeaders].length === 1,
);
setHeaders.delete("X");
check("delete and has normalize names", !setHeaders.has("x"));

const copy = new Headers(h);
h.delete("x-a");
check("Headers init copies the list", copy.get("x-a") === "1, 2");

const coercive = new Headers();
coercive.append({ toString: () => "X-Coerced" }, { toString: () => " value " });
check("method arguments use ToString", coercive.get("x-coerced") === "value");

check(
	"non-object init rejected",
	rejectsTypeError(() => new Headers(null)) && rejectsTypeError(() => new Headers("x")),
);
check(
	"empty name rejected",
	rejectsTypeError(() => new Headers({ "": "x" })),
);
check(
	"invalid token name rejected",
	rejectsTypeError(() => h.append("bad name", "x")),
);
check(
	"non-ByteString name rejected",
	rejectsTypeError(() => h.has("x-\u0100")),
);
check(
	"NUL value rejected",
	rejectsTypeError(() => h.set("x", "a\0b")),
);
check(
	"CR/LF value rejected",
	rejectsTypeError(() => h.append("x", "a\r\nb")),
);
check(
	"non-ByteString value rejected",
	rejectsTypeError(() => h.append("x", "a\u0100b")),
);
check(
	"required arguments enforced",
	rejectsTypeError(() => h.get()) &&
		rejectsTypeError(() => h.delete()) &&
		rejectsTypeError(() => h.append("x")),
);
const response = new Response("", { headers: { "X-Response": " value " } });
check(
	"Response uses normalized Headers init",
	response.headers.get("x-response") === "value" &&
		rejectsTypeError(() => new Response("", { headers: { "bad name": "x" } })),
);
check(
	"Request propagates Headers validation",
	rejectsTypeError(
		() => new Request("https://example.com/", { headers: { "bad name": "x" } }),
	),
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
