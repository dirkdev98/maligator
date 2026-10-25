const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;
function conditionalFirst(flag, left, right, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	return [flag !== flag ? observe("first") : left, right];
}
function conditionalLast(flag, left, right, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	return [left, flag !== flag ? observe("last") : right];
}
function conditionalBoth(flag, left, right, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	return [
		flag !== flag ? observe("first") : left,
		flag === flag ? right : observe("last"),
	];
}
function liveInitializer(flag, left, right, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	return [flag !== flag ? observe("dead") : left, observe(right)];
}
function hole(flag, left, right, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	return [flag !== flag ? observe("dead") : left, , right];
}
function protectedInitializer(flag, left, right, observe) {
	for (let i = 0; i < 2; i++) observe(i);
	try {
		return [flag !== flag ? observe("dead") : left, observe(right)];
	} catch (error) {
		return error;
	}
}
globalThis.arrayFirst = conditionalFirst;
globalThis.arrayLive = liveInitializer;
const rows = [];
for (let round = 0; round < 8; round++) {
	let order = "";
	const left = { round, parts: [round, "left"] };
	const right = { round, parts: ["right", round] };
	function observe(value) {
		order += typeof value === "number" ? value : typeof value === "string" ? value : "v";
		collectGarbage?.();
		return value;
	}
	globalThis.arrayObserve = observe;
	const first = conditionalFirst("string", left, right, globalThis.arrayObserve);
	const last = conditionalLast("string", left, right, globalThis.arrayObserve);
	const both = conditionalBoth("string", left, right, globalThis.arrayObserve);
	const live = liveInitializer("string", left, right, globalThis.arrayObserve);
	collectGarbage?.();
	for (const result of [first, last, both, live]) {
		if (
			result.length !== 2 ||
			result[0] !== left ||
			result[1] !== right ||
			result[0].parts[0] !== round ||
			result[1].parts[1] !== round ||
			Object.keys(result).join(",") !== "0,1"
		)
			throw new Error("surviving initializer values");
	}
	if (order !== "01010101v") throw new Error("surviving initializer order");
	rows.push(order);
	order = "";
	const nanFirst = conditionalFirst(NaN, left, right, globalThis.arrayObserve);
	const nanLast = conditionalLast(NaN, left, right, globalThis.arrayObserve);
	const nanBoth = conditionalBoth(NaN, left, right, globalThis.arrayObserve);
	if (
		nanFirst[0] !== "first" ||
		nanFirst[1] !== right ||
		nanLast[0] !== left ||
		nanLast[1] !== "last" ||
		nanBoth[0] !== "first" ||
		nanBoth[1] !== "last" ||
		order !== "01first01last01firstlast"
	)
		throw new Error("NaN fallback");
	const sparse = hole("string", left, right, observe);
	if (sparse.length !== 3 || Object.hasOwn(sparse, 1) || sparse[2] !== right)
		throw new Error("hole fallback");
}
for (const value of [undefined, null, 123n, Symbol("element"), "𝌆", -0, ["nested"]]) {
	const result = globalThis.arrayFirst("string", value, value, () => collectGarbage?.());
	collectGarbage?.();
	if (!Object.is(result[0], value) || !Object.is(result[1], value))
		throw new Error("mixed initializer values");
}
let order = "";
const thrown = { thrown: true };
function fail(value) {
	order += value;
	collectGarbage?.();
	if (value === "throw") throw thrown;
	return value;
}
try {
	liveInitializer("string", { retained: true }, "throw", fail);
	throw new Error("missing initializer exception");
} catch (caught) {
	if (caught !== thrown || order !== "01throw")
		throw new Error("initializer exception order");
}
order = "";
if (protectedInitializer("string", null, "throw", fail) !== thrown || order !== "01throw")
	throw new Error("protected initializer exception");
let inheritedWrites = 0;
const mutable = process.env.MAL_PRIMORDIALS !== "locked";
if (mutable)
	Object.defineProperty(Array.prototype, "1", {
		configurable: true,
		set() {
			inheritedWrites++;
		},
	});
try {
	const result = liveInitializer("string", "left", "right", (value) => {
		collectGarbage?.();
		return value;
	});
	if (result[0] !== "left" || result[1] !== "right" || !Object.hasOwn(result, 1))
		throw new Error("inherited setter intercepted initializer");
} finally {
	if (mutable) delete Array.prototype[1];
}
if (inheritedWrites !== 0) throw new Error("inherited initializer setter ran");
rows.push(order, inheritedWrites);
console.log(JSON.stringify(rows));
