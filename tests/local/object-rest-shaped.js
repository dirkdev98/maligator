"use strict";

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("object-rest-shaped requires MAL_HOST_GC=1");
}

let passed = 0;
function check(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function omitStatic(source) {
	const { omitted, ...rest } = source;
	return [omitted, rest];
}

const shapedSource = { omitted: 1, alpha: 2, beta: 3, gamma: 4 };
for (let i = 0; i < 32; i++) {
	const [omitted, rest] = omitStatic(shapedSource);
	check(
		"shaped copy " + i,
		omitted === 1 &&
			rest.alpha === 2 &&
			rest.beta === 3 &&
			rest.gamma === 4 &&
			!("omitted" in rest),
	);
}

const [, shapedRest] = omitStatic(shapedSource);
const alphaDescriptor = Object.getOwnPropertyDescriptor(shapedRest, "alpha");
check(
	"result contract",
	Object.getPrototypeOf(shapedRest) === Object.prototype &&
		Object.keys(shapedRest).join(",") === "alpha,beta,gamma" &&
		alphaDescriptor.value === 2 &&
		alphaDescriptor.writable === true &&
		alphaDescriptor.enumerable === true &&
		alphaDescriptor.configurable === true,
);

function omitComputed(source, key) {
	const { [key]: omitted, ...rest } = source;
	return [omitted, rest];
}

let coercions = 0;
const computedKey = {
	toString() {
		coercions++;
		gc();
		return ["omit", "ted"].join("");
	},
};
const [computedOmitted, computedRest] = omitComputed(shapedSource, computedKey);
check(
	"computed exclusion survives collection",
	coercions === 1 &&
		computedOmitted === 1 &&
		computedRest.alpha === 2 &&
		!("omitted" in computedRest),
);

const indexedSource = { 0: "drop", keep: "indexed" };
const { 0: indexedOmitted, ...indexedRest } = indexedSource;
check(
	"indexed fallback",
	indexedOmitted === "drop" && indexedRest.keep === "indexed" && !("0" in indexedRest),
);

const symbol = Symbol("copied");
const symbolSource = { omitted: 1, keep: 2, [symbol]: 3 };
const [, symbolRest] = omitStatic(symbolSource);
check(
	"symbol fallback",
	symbolRest.keep === 2 &&
		symbolRest[symbol] === 3 &&
		Object.getOwnPropertySymbols(symbolRest)[0] === symbol,
);

let getterCalls = 0;
const accessorSource = { omitted: 1, keep: 2 };
Object.defineProperty(accessorSource, "observed", {
	enumerable: true,
	get() {
		getterCalls++;
		gc();
		return 3;
	},
});
Object.defineProperty(accessorSource, "hidden", {
	enumerable: false,
	value: 4,
});
const [, accessorRest] = omitStatic(accessorSource);
check(
	"descriptor fallback",
	getterCalls === 1 &&
		accessorRest.keep === 2 &&
		accessorRest.observed === 3 &&
		!("hidden" in accessorRest),
);

const wideSource = { omitted: "drop" };
for (let i = 0; i < 40; i++) wideSource["field-" + i] = i;
const [, wideRest] = omitStatic(wideSource);
check(
	"wide fallback",
	Object.keys(wideRest).length === 40 &&
		wideRest["field-0"] === 0 &&
		wideRest["field-39"] === 39,
);

gc();
check(
	"results survive collection",
	shapedRest.gamma === 4 &&
		computedRest.beta === 3 &&
		indexedRest.keep === "indexed" &&
		symbolRest[symbol] === 3 &&
		accessorRest.observed === 3 &&
		wideRest["field-20"] === 20,
);

console.log("object-rest-shaped PASS " + passed + "/" + passed);
