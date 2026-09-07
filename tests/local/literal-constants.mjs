function has(value, from) {
	return ["foo", "bar", null, false, true, -0, 2.5, 5n].includes(value, from);
}
function nested(value) {
	return [{ a: [1, { b: "two" }] }, [3, 4]].includes(value);
}
let coercions = 0;
const from = {
	valueOf() {
		coercions++;
		return has("foo", 0) ? -7 : 0;
	},
};
let checksum = 0;
for (let i = 0; i < 10000; i++) {
	checksum += has(i % 2 ? "foo" : "missing", 0) ? 1 : 0;
	checksum += has(5n, from) ? 1 : 0;
	if (nested({ a: [1, { b: "two" }] })) throw new Error("nested identity escaped");
}
for (const value of [null, false, true, 0, -0, 2.5, 5n])
	if (!has(value)) throw new Error("constant value");
function escaped() {
	const a = ["foo", "bar"];
	a.includes("foo");
	return a;
}
const first = escaped();
first[0] = "changed";
if (escaped()[0] !== "foo" || escaped() === escaped())
	throw new Error("shared escaping array");
function mutate(value) {
	const a = ["foo", "bar"];
	a[0] = value;
	return a.includes("foo");
}
if (mutate("bad") || !mutate("foo")) throw new Error("mutation");
let threw = false;
try {
	has("foo", {
		valueOf() {
			throw new Error("from");
		},
	});
} catch {
	threw = true;
}
if (!threw) throw new Error("missing coercion throw");
let emptyCoercions = 0;
if (
	[].includes("foo", {
		valueOf() {
			emptyCoercions++;
			return 0;
		},
	}) ||
	emptyCoercions !== 0
)
	throw new Error("empty coercion");
console.log(checksum, coercions, "literal constants passed");
function methods(x) {
	const results = [
		"hello".slice(1),
		"hello".includes(x),
		"hello".replace(/l/g, "L"),
		"AbC".toLowerCase(),
		" abc ".trim(),
		"abc".split("b").join("|"),
		"abc"[Symbol.iterator]().next().value,
		(42).toString(16),
		(1.25).toFixed(1),
		true.toString(),
		false.valueOf(),
		5n.toString(),
		{ a: [1, { b: false }] }.hasOwnProperty(x),
		{ a: 1 }.propertyIsEnumerable("a"),
		{ a: 1 }.toString(),
		[1, 2, 3].join("-"),
		[1, 2, 3].indexOf(x),
		[1, 2, 3].lastIndexOf(x),
		[1, 2, 3].slice(1).join(),
		[1, 2].concat([3]).join(),
		[1, 2, 3].at(-1),
		[1, 2, 3].toReversed().join(),
		[3, 1, 2].toSorted().join(),
		[1, 2, 3].toSpliced(1, 1, 4).join(),
		[1, 2, 3].with(1, 4).join(),
		[1, 2].keys().next().value,
		[1, 2].values().next().value,
		[1, 2].entries().next().value.join(),
		[1, 2][Symbol.iterator]().next().value,
		[, 2].includes(undefined),
		[, 2].indexOf(undefined),
		[, 2].slice().join(),
	];
	return JSON.stringify(results);
}
console.log(methods("a"));
console.log(methods(2));
function freshMethods() {
	const nestedCopy = [{ a: 1 }].slice();
	const returned = { a: [1] }.valueOf();
	const mapped = [1, 2].map((x, i, a) => {
		if (i === 0) a[1] = 4;
		return x;
	});
	return [nestedCopy, returned, mapped];
}
const a = freshMethods(),
	b = freshMethods();
if (a[0][0] === b[0][0] || a[1] === b[1] || a[1].a === b[1].a)
	throw new Error("method result identity");
console.log(JSON.stringify(a[2]), JSON.stringify(b[2]));
console.log([1, 2].push(3), [1, 2].pop(), [1, 2].reverse().join(), [1, 2].fill(4).join());
let ownMethodThrew = false;
try {
	({ hasOwnProperty: 1, a: { b: [1, 2, 3] } }).hasOwnProperty("a");
} catch (e) {
	ownMethodThrew = e instanceof TypeError;
}
if (!ownMethodThrew) throw new Error("own method shadow");
function isNil(x) {
	return x === null || x === undefined;
}
console.log(isNil(true), isNil(null), isNil(undefined));

function conditional(x) {
	const a = [1, 2, 3];
	if (x) return a.includes(x);
	return a.indexOf(x);
}
console.log(conditional(1), conditional(0), conditional(4));

function shadowThroughNestedLiteral(value) {
	const child = [1, 2];
	const parents = [child];
	parents.forEach((array) => {
		array.includes = () => value;
	});
	return child.includes("missing");
}
if (!shadowThroughNestedLiteral(true) || shadowThroughNestedLiteral(false))
	throw new Error("nested literal method shadowing");

let nullPrototypeThrew = false;
try {
	({ __proto__: null, a: [1] }).toString();
} catch (e) {
	nullPrototypeThrew = e instanceof TypeError;
}
if (!nullPrototypeThrew) throw new Error("literal prototype override");

for (const call of [() => [1, 2]["@@iterator"](), () => "abc"["@@iterator"]()]) {
	let stringKeyThrew = false;
	try {
		call();
	} catch (error) {
		stringKeyThrew = error instanceof TypeError;
	}
	if (!stringKeyThrew) throw new Error("string key confused with Symbol.iterator");
}
