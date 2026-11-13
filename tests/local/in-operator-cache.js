const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

const OPERATORS = ["lt", "lte", "gt", "gte", "eq", "ne", "in", "contains"];
function knownOperators(value) {
	const found = [];
	for (const op of OPERATORS) if (op in value) found.push(op);
	return found.join("|");
}
const condition = JSON.parse('{"gte":500}');
const repeatedCalls = 2000;
let repeated = "";
for (let i = 0; i < repeatedCalls; i++) repeated = knownOperators(condition);
record("repeated", repeated);
record("repeatedMisses", repeatedCalls * (OPERATORS.length - 1));

function has(object, key) {
	return key in object;
}
function warm(object, key) {
	let last = false;
	for (let i = 0; i < 64; i++) last = has(object, key);
	return last;
}

const plain = { a: 1 };
record("ownPresent", warm(plain, "a"));
record("inherited", warm(plain, "toString"));
record("missingBefore", warm(plain, "addedLater"));
Object.prototype.addedLater = 1;
record("missingAfterPrototypeAdd", warm(plain, "addedLater"));
delete Object.prototype.addedLater;
record("missingAfterPrototypeDelete", warm(plain, "addedLater"));

class Base {
	method() {}
}
class Derived extends Base {}
const instance = new Derived();
record("classMethod", warm(instance, "method"));
record("classMissing", warm(instance, "extra"));
Base.prototype.extra = 2;
record("classAfterBaseAdd", warm(instance, "extra"));
delete Base.prototype.method;
record("classAfterBaseDelete", warm(instance, "method"));

const reparented = { own: 1 };
record("beforeReparent", warm(reparented, "special"));
Object.setPrototypeOf(reparented, { special: true });
record("afterReparent", warm(reparented, "special"));
Object.setPrototypeOf(Object.getPrototypeOf(reparented), null);
record("afterGrandparentCut", warm(reparented, "toString"));

const sameShapeA = { x: 1 };
const sameShapeB = Object.create({ x: 0, y: 0 });
sameShapeB.x = 1;
record("sameShapeOtherPrototype", `${warm(sameShapeA, "y")},${warm(sameShapeB, "y")}`);

const nullPrototype = Object.create(null);
nullPrototype.k = 1;
record("nullPrototype", `${warm(nullPrototype, "k")},${warm(nullPrototype, "toString")}`);

let trapCalls = 0;
const proxied = Object.create(
	new Proxy(
		{},
		{
			has(target, key) {
				trapCalls++;
				return key === "virtual";
			},
		},
	),
);
record(
	"proxyChain",
	`${warm(proxied, "virtual")},${warm(proxied, "other")},${trapCalls}`,
);

let getterCalls = 0;
const withGetter = {
	get lazy() {
		getterCalls++;
		return 1;
	},
};
record("getterNotRun", `${warm(withGetter, "lazy")},${getterCalls}`);

const prefix = "gt";
const fresh = `${prefix}e`;
record("nonAtomKey", `${warm(condition, fresh)},${warm(condition, prefix)}`);
record(
	"indexKey",
	`${warm({ 0: "zero" }, "0")},${warm([1, 2], "1")},${warm([1, 2], "2")}`,
);
const symbol = Symbol("tag");
record("symbolKey", `${warm({ [symbol]: 1 }, symbol)},${warm({}, symbol)}`);

const deleted = { a: 1, b: 2 };
warm(deleted, "b");
delete deleted.b;
record("afterOwnDelete", warm(deleted, "b"));

let threw = "";
try {
	has(1, "a");
} catch (error) {
	threw = error instanceof TypeError;
}
record("primitiveThrows", threw);

console.log(results.join("\n"));
