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
		if (result.groups !== undefined) {
			assert(
				Object.getPrototypeOf(result.indices.groups) === null,
				"indices groups null prototype",
			);
			assert(
				result.indices.groups.tree === result.indices[1],
				"named indices share the capture pair",
			);
			assert(result.indices.groups.absent === undefined, "unmatched named indices");
		}
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

const nested = /(?<outer>(?<inner>birch))/d.exec("birch");
assert(nested.indices.groups.outer === nested.indices[1], "outer capture identity");
assert(nested.indices.groups.inner === nested.indices[2], "inner capture identity");
assert(
	nested.indices[1] !== nested.indices[2],
	"equal ranges have distinct capture pairs",
);
nested.indices.groups.outer[0] = 2;
collect();
assert(
	nested.indices[1][0] === 2 && nested.indices[2][0] === 0,
	"named pair mutation is shared",
);

const repeated = /(?<tree>birch)/d;
const first = repeated.exec("birch");
const second = repeated.exec("birch");
assert(first.groups !== second.groups, "each result owns its groups object");
assert(
	first.indices.groups !== second.indices.groups,
	"each result owns its indices groups object",
);
assert(first.indices[1] !== second.indices[1], "each result owns its capture pairs");
first.groups.tree = "cedar";
delete second.indices.groups.tree;
collect();
const fresh = repeated.exec("birch");
assert(
	fresh.groups.tree === "birch" && fresh.indices.groups.tree === fresh.indices[1],
	"group mutations do not affect later results",
);

const cloned = [..."birch birch".matchAll(new RegExp(repeated, "dg"))];
collect();
assert(
	cloned.length === 2 && cloned[1].indices.groups.tree === cloned[1].indices[1],
	"matchAll named pair identity",
);
const sharedPattern = /(?<tree>birch)/dg;
const initialShared = sharedPattern.exec("birch");
assert(
	initialShared.indices.groups.tree === initialShared.indices[1],
	"original layout before cloning",
);
sharedPattern.lastIndex = 0;
const sharedIterator = "birch birch".matchAll(sharedPattern);
sharedPattern.compile("(?<leaf>cedar)", "dg");
collect();
const sharedResults = [...sharedIterator];
assert(
	sharedResults[1].groups.tree === "birch" &&
		sharedResults[1].indices.groups.tree === sharedResults[1].indices[1],
	"matchAll retains the original layout across compile",
);
repeated.compile("(?<leaf>cedar)", "d");
const recompiled = repeated.exec("cedar");
collect();
assert(
	Object.keys(recompiled.groups).join(",") === "leaf",
	"compile replaces capture names",
);
assert(
	recompiled.indices.groups.leaf === recompiled.indices[1],
	"recompiled capture identity",
);

const alternatives = /(?:(?<tree>birch)|(?<tree>cedar))(?<tail>x)?/d;
for (const [input, selected] of [
	["birch", 1],
	["cedar", 2],
]) {
	const result = alternatives.exec(input);
	assert(
		result.groups.tree === input,
		"duplicate name selects the participating capture",
	);
	assert(
		result.indices.groups.tree === result.indices[selected],
		"duplicate name pair identity",
	);
	assert(
		Object.keys(result.groups).join(",") === "tree,tail",
		"duplicate name property order",
	);
	collect();
	assert(result.indices.groups.tail === undefined, "unmatched duplicate-name companion");
}

const longName = `tree${"e".repeat(140)}`;
const longNamed = new RegExp(`(?<${longName}>birch)`, "d").exec("birch");
collect();
assert(
	longNamed.groups[longName] === "birch" &&
		longNamed.indices.groups[longName] === longNamed.indices[1],
	"long capture name identity",
);

const captureNames = Array.from({ length: 260 }, (_, index) => `leaf${index}`);
const manyNamed = new RegExp(
	captureNames.map((name) => `(?<${name}>a)`).join(""),
	"d",
).exec("a".repeat(captureNames.length));
collect();
assert(
	Object.keys(manyNamed.groups).join(",") === captureNames.join(","),
	"wide named capture order",
);
for (const [index, name] of captureNames.entries()) {
	assert(
		manyNamed.groups[name] === "a" &&
			manyNamed.indices.groups[name] === manyNamed.indices[index + 1],
		"wide named capture identity",
	);
}

const unicodeSticky = /(?<leaf>🌲)(?<stem>é)?/duy;
const unicodeResult = unicodeSticky.exec("🌲é");
collect();
assert(
	unicodeResult.indices.groups.leaf === unicodeResult.indices[1] &&
		unicodeResult.indices[1][1] === 2,
	"unicode sticky capture identity and offsets",
);
assert(
	unicodeSticky.lastIndex === 3 &&
		unicodeSticky.exec("x") === null &&
		unicodeSticky.lastIndex === 0,
	"sticky lastIndex success and failure",
);

const namedSticky = /(?<key>[a-z]+)=(?<value>\d+)/dgy;
for (const input of ["no match", "route=123", "no match", "field=234", "no match"]) {
	namedSticky.lastIndex = 0;
	const result = namedSticky.exec(input);
	if (input === "no match") {
		assert(
			result === null && namedSticky.lastIndex === 0,
			"cached named misses reset lastIndex",
		);
	} else {
		assert(result.groups.key === input.slice(0, 5), "success after a cached named miss");
		assert(
			result.indices.groups.value === result.indices[2] &&
				namedSticky.lastIndex === input.length,
			"capture identity and lastIndex after a cached miss",
		);
	}
	collect();
}
console.log("PASS");
