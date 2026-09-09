const realm = globalThis;
const indirectEval = eval;
const FunctionConstructor = Function;
const names = [
	"Number",
	"Object",
	"Array",
	"String",
	"Map",
	"Set",
	"Math",
	"Reflect",
	"globalThis",
];
const originals = names.map((name) => realm[name]);
let results;
try {
	for (const name of names) realm[name] = null;
	results = [
		indirectEval(
			"[1 + 2, Number, Object, Array, String, Map, Set, Math, Reflect, globalThis]",
		),
		FunctionConstructor(
			"return [2 + 3, Number, Object, Array, String, Map, Set, Math, Reflect, globalThis]",
		)(),
		eval("[3 + 4, Number, Object, Array, String, Map, Set, Math, Reflect, globalThis]"),
	];
} finally {
	for (let index = 0; index < names.length; index++)
		realm[names[index]] = originals[index];
}
for (let index = 0; index < results.length; index++) {
	const result = results[index];
	if (
		result[0] !== 3 + index * 2 ||
		result.length !== 10 ||
		result.slice(1).some((value) => value !== null)
	) {
		throw new Error("dynamic code must observe replaced globals");
	}
}
let reads = 0;
Object.defineProperty(realm, "Number", {
	configurable: true,
	get() {
		reads++;
		return 17;
	},
});
try {
	if (indirectEval("Number + 1") !== 18 || reads !== 1) {
		throw new Error("compiler must not invoke the user global getter");
	}
} finally {
	Object.defineProperty(realm, "Number", {
		configurable: true,
		writable: true,
		value: originals[0],
	});
}
console.log("eval replaced globals passed");
