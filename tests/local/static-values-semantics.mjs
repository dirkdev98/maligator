import { evaluateConstantOperation } from "../../src/compiler/shared/constant-evaluator.ts";

function assert(value, message) {
	if (!value) throw new Error(message);
}
function fresh() {
	return { child: { value: 1 } };
}
const first = fresh();
const second = fresh();
assert(first !== second && first.child !== second.child, "fresh graph identities");
const alias = first;
assert(alias === first, "alias identity");
function recurse(n) {
	const value = { n };
	return n ? value !== recurse(n - 1) && value : value;
}
assert(recurse(4).n === 4, "recursive identities");
function closure() {
	return () => 1;
}
assert(closure() !== closure(), "function identities");
const iterations = [];
for (let i = 0; i < 3; i++) iterations.push({ i });
assert(
	iterations[0] !== iterations[1] && iterations[1] !== iterations[2],
	"loop identities",
);
const symbols = [Symbol("x"), Symbol("x")];
assert(symbols[0] !== symbols[1], "symbol identities");
const order = [];
assert(
	![].includes(1, {
		valueOf() {
			throw new Error("empty search coerced fromIndex");
		},
	}),
	"empty search early return",
);
let lengthReads = 0;
const deferredKeys = Array.prototype.keys.call({
	get length() {
		lengthReads++;
		return 1;
	},
});
assert(lengthReads === 0, "iterator creation defers length read");
assert(
	deferredKeys.next().value === 0 && lengthReads === 1,
	"iterator next reads length",
);
const array = [1, 2, 3];
assert(
	array.includes(2, {
		valueOf() {
			order.push("index");
			return 1;
		},
	}),
	"coerced index",
);
const joined = [
	{
		toString() {
			order.push("element");
			return "x";
		},
	},
].join({
	toString() {
		order.push("separator");
		return "-";
	},
});
assert(joined === "x" && order.join(",") === "index,separator,element", "coercion order");
const mapped = [1].map((value, index, receiver) => {
	receiver[0] = 4;
	return receiver;
});
assert(mapped[0][0] === 4, "callback receiver exposure");
const privateObject = { x: 1 };
assert(privateObject.valueOf() === privateObject, "valueOf alias");
const slice = array.slice();
assert(slice !== array && slice[0] === 1, "slice freshness");
const keys = array.keys();
array.push(4);
assert([...keys].length === 4, "retained iterator state");
let comparisons = 0;
assert(
	[3, 1, 2]
		.toSorted((a, b) => {
			comparisons++;
			return a - b;
		})
		.join() === "1,2,3" && comparisons > 0,
	"comparator effects",
);
const shadow = [1];
shadow.includes = () => "own";
assert(shadow.includes(1) === "own", "own shadow");
const changed = [1];
Object.setPrototypeOf(changed, {
	includes() {
		return "prototype";
	},
});
assert(
	Array.isArray(changed) && changed.includes(1) === "prototype",
	"brand does not prove prototype",
);
class SubArray extends Array {
	includes() {
		return "subclass";
	}
}
assert(new SubArray(1).includes(1) === "subclass", "subclass override");
const traps = [];
const proxy = new Proxy(
	{ length: 1, 0: 5 },
	{
		get(target, key) {
			traps.push(String(key));
			return target[key];
		},
	},
);
assert(
	Array.prototype.includes.call(proxy, 5) && traps.join() === "length,0",
	"proxy reads",
);
let speciesCalls = 0;
class SpeciesArray extends Array {
	static get [Symbol.species]() {
		speciesCalls++;
		return Array;
	}
}
assert(
	new SpeciesArray(1, 2).slice().length === 2 && speciesCalls === 1,
	"species lookup",
);
const jsonOrder = [];
JSON.stringify(
	{
		toJSON() {
			jsonOrder.push("toJSON");
			return { x: 1 };
		},
	},
	(key, value) => {
		jsonOrder.push(key);
		return value;
	},
);
assert(jsonOrder.join(",") === "toJSON,,x", "toJSON before replacer");
const throws = [];
try {
	throws.push("before");
	const value = 1n / 0n;
	throws.push(String(value));
} catch (error) {
	throws.push(error.name);
}
assert(throws.join() === "before,RangeError", "residual throw order");
assert(Object.is(-0 / 2, -0) && Object.is(-4 % 2, -0), "signed zero");
assert(
	Number.MIN_VALUE / 2 === 0 && Number.MIN_VALUE + Number.MIN_VALUE === 1e-323,
	"subnormals",
);
assert(
	Number.isNaN(0 / 0) && 9007199254740992 + 1 === 9007199254740992,
	"binary64 rounding",
);
assert("\ud800x".charCodeAt(0) === 55296, "UTF16 code units");
const max = 170141183460469231731687303715884105727n;
const min = -170141183460469231731687303715884105728n;
for (const [op, a, b, kind] of [
	["+", max, 1n, "unsupported"],
	["*", min, -1n, "unsupported"],
	["/", min, -1n, "unsupported"],
	["%", min, -1n, "value"],
	["/", 1n, 0n, "throw"],
]) {
	const result = evaluateConstantOperation("bigint.binary:" + op, [
		{ kind: "bigint", value: a },
		{ kind: "bigint", value: b },
	]);
	assert(result.kind === kind, "bounded evaluator " + op);
}
console.log("static value semantic boundaries passed");
