const collectGarbage = globalThis.__mal_collect_garbage ?? globalThis.gc;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function collect() {
	if (typeof collectGarbage === "function") collectGarbage();
}

function checkResult(result, source, hasIndices) {
	assert(Array.isArray(result), "result remains an Array");
	assert(Object.getPrototypeOf(result) === Array.prototype, "intrinsic prototype");
	const names = ["index", "input", "groups"];
	if (hasIndices) names.push("indices");
	const indices = Array.from({ length: result.length }, (_, index) => String(index));
	assert(
		Object.keys(result).join(",") === [...indices, ...names].join(","),
		"enumerable property order",
	);
	assert(
		Object.getOwnPropertyNames(result).join(",") ===
			[...indices, "length", ...names].join(","),
		"own property order",
	);
	for (const name of [...indices, ...names]) {
		const descriptor = Object.getOwnPropertyDescriptor(result, name);
		assert(
			descriptor.writable && descriptor.enumerable && descriptor.configurable,
			"default data attributes",
		);
	}
	assert(result.input === source && result.index === 1, "match metadata");
	assert(result[0] === "birch=7" && result[1] === "birch", "capture elements");
	assert(result[2] === "7" && result[3] === undefined, "unmatched capture");
	if (result.groups !== undefined) {
		assert(Object.getPrototypeOf(result.groups) === null, "groups null prototype");
		assert(result.groups.tree === "birch", "named capture");
		assert(result.groups.absent === undefined, "unmatched named capture");
	}
	if (hasIndices) {
		assert(result.indices[0][0] === 1 && result.indices[0][1] === 8, "match indices");
		assert(result.indices[3] === undefined, "unmatched indices");
		assert(
			Object.keys(result.indices).join(",") === [...indices, "groups"].join(","),
			"indices property order",
		);
		const descriptor = Object.getOwnPropertyDescriptor(result.indices, "groups");
		assert(
			descriptor.writable && descriptor.enumerable && descriptor.configurable,
			"indices groups attributes",
		);
	}
}

const source = "/birch=7";
for (const pattern of [
	/([a-z]+)=(\d+)(x)?/,
	/(?<tree>[a-z]+)=(\d+)(?<absent>x)?/,
	/([a-z]+)=(\d+)(x)?/d,
	/(?<tree>[a-z]+)=(\d+)(?<absent>x)?/d,
]) {
	for (const result of [pattern.exec(source), source.match(pattern)]) {
		checkResult(result, source, pattern.hasIndices);
		collect();
		checkResult(result, source, pattern.hasIndices);
		const metadata = { tree: "cedar" };
		result.extra = metadata;
		for (let index = 0; index < 24; index++) result[`field${index}`] = metadata;
		result.push(metadata);
		collect();
		assert(result.extra === metadata && result[4] === metadata, "both storage growths");
		assert(result.field23 === metadata && result.input === source, "grown named fields");
		delete result.input;
		result.input = metadata;
		Object.defineProperty(result, "groups", {
			get() {
				return metadata;
			},
			configurable: true,
		});
		result[10_000] = metadata;
		collect();
		assert(result.groups === metadata && result.input === metadata, "dictionary fields");
		assert(result[10_000] === metadata && result[1] === "birch", "sparse transition");
	}
}

const retained = [...source.matchAll(/(?<tree>[a-z]+)=(\d+)(?<absent>x)?/dg)];
collect();
checkResult(retained[0], source, true);
Object.freeze(retained[0]);
collect();
assert(
	Object.isFrozen(retained[0]) && retained[0].groups.tree === "birch",
	"frozen result",
);

const resized = /([a-z]+)/.exec("birch");
const prototype = Object.create(Array.prototype);
prototype.tree = { name: "cedar" };
Object.setPrototypeOf(resized, prototype);
resized.length = 0;
resized.push(prototype.tree);
collect();
assert(
	resized[0] === prototype.tree && resized.input === "birch" && resized.index === 0,
	"length reset and prototype change",
);
Object.setPrototypeOf(resized, Array.prototype);
assert(Object.getPrototypeOf(resized) === Array.prototype, "restored prototype");

const widePattern = new RegExp("(a)".repeat(40), "d");
const wide = widePattern.exec("a".repeat(40));
collect();
assert(wide.length === 41 && wide[40] === "a", "wide capture storage");
assert(wide.indices[40][0] === 39 && wide.indices[40][1] === 40, "wide indices");
for (let index = 0; index < 20; index++) wide[`field${index}`] = { index };
Object.defineProperty(wide, "0", { get: () => "changed", configurable: true });
collect();
assert(wide[0] === "changed" && wide.field19.index === 19, "deoptimized wide result");
console.log("PASS");
