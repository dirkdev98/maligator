function check(value, message) {
	if (!value) throw new Error(message);
}

function reverse(child) {
	return [child, , child].toReversed();
}
function replace(child) {
	return [child, , child].with(-1.8, 9);
}
function splice(child) {
	return [child, , child].toSpliced(1, 1, child);
}
function of(child) {
	return Array.of(child, child);
}
function slice(child) {
	return [0, child, , child].slice(1, undefined);
}
function concat(child) {
	return [child, , 1].concat([child, , 2], "ab", null);
}
function flat(child) {
	return [, child, , child, ,].flat(0);
}

const child = {};
const first = reverse(child);
const second = reverse(child);
check(first !== second, "copy shells must be fresh");
check(first[0] === child && first[2] === child, "reverse preserves child identity");
check(Object.hasOwn(first, 1) && first[1] === undefined, "reverse densifies holes");
const replaced = replace(child);
check(replaced[0] === child && replaced[2] === 9, "with truncates negative indexes");
check(Object.hasOwn(replaced, 1), "with densifies holes");
const spliced = splice(child);
check(
	spliced[0] === child && spliced[1] === child && spliced[2] === child,
	"splice aliases",
);

const factory = of(child);
check(factory !== of(child), "Array.of shells must be fresh");
check(factory[0] === child && factory[1] === child, "Array.of preserves child aliases");
const sliced = slice(child);
check(sliced !== slice(child), "slice shells must be fresh");
check(sliced[0] === child && sliced[2] === child, "slice preserves child aliases");
check(sliced.length === 3 && !Object.hasOwn(sliced, 1), "slice preserves holes");
const onlyHoles = [, , ,].slice();
check(
	onlyHoles.length === 3 && Object.keys(onlyHoles).length === 0,
	"slice materializes all-hole arrays without own undefined elements",
);
const edgeHoles = [, child, ,].slice();
check(
	edgeHoles.length === 3 &&
		!Object.hasOwn(edgeHoles, 0) &&
		!Object.hasOwn(edgeHoles, 2) &&
		edgeHoles[1] === child,
	"slice retains leading and trailing holes around child aliases",
);
check([1, 2, 3].slice(-2.8, Infinity).join() === "2,3", "slice clamps numeric bounds");
check([1, 2, 3].slice(2, 1).length === 0, "slice reversed bounds produce an empty array");
check([1, 2, 3].slice(false, true).join() === "1", "slice converts boolean bounds");
check(
	[1, 2, 3].slice(null, "2").join() === "1,2",
	"slice converts null and string bounds",
);
check(
	[1, 2, 3].slice(" -2.8 ", "Infinity").join() === "2,3",
	"slice truncates negative string bounds and clamps infinity",
);
check([1, 2, 3].slice("-0", "1").join() === "1", "slice converts negative zero strings");
check(
	[1, 2, 3].slice("not-a-number", 1).join() === "1",
	"slice treats invalid numeric strings as zero",
);
check([1, 2, 3].with(true, 9).join() === "1,9,3", "with converts boolean indexes");
check([1, 2, 3].with(null, 9).join() === "9,2,3", "with converts null indexes");
check([1, 2, 3].with("-1.8", 9).join() === "1,2,9", "with truncates string indexes");
check([1, 2, 3].with("-0", 9).join() === "9,2,3", "with treats negative zero as zero");
check(
	[1, 2, 3].toSpliced(true, "1", 9).join() === "1,9,3",
	"toSpliced converts boolean start and string delete count",
);
check(
	[1, 2, 3].toSpliced(null, false, 9).join() === "9,1,2,3",
	"toSpliced converts null start and false delete count to zero",
);
check(
	[1, 2, 3].toSpliced("-1.8", "Infinity", 9).join() === "1,2,9",
	"toSpliced clamps string delete counts after truncating start",
);
check(
	[1, 2, 3].toSpliced("Infinity", "-Infinity", 9).join() === "1,2,3,9",
	"toSpliced clamps infinite string bounds",
);

let speciesCalls = 0;
const customSpecies = [1, 2, 3];
customSpecies.constructor = {
	get [Symbol.species]() {
		speciesCalls++;
		return Array;
	},
};
check(
	customSpecies.slice(1).join() === "2,3" && speciesCalls === 1,
	"slice reads custom species",
);

let calls = 0;
const withGetter = [1, 2, 3];
Object.defineProperty(withGetter, 1, {
	get() {
		calls++;
		return 8;
	},
});
check(
	withGetter.with(1, 9).join() === "1,9,3" && calls === 0,
	"with skips replaced getter",
);
check(
	withGetter.toSpliced(1, 1).join() === "1,3" && calls === 0,
	"splice skips removed getter",
);
check(withGetter.toReversed().join() === "3,8,1" && calls === 1, "reverse reads getter");

check([1, 2, 3].toSpliced().join() === "1,2,3", "omitted start copies contents");
check([1, 2, 3].toSpliced(1).join() === "1", "omitted delete count removes suffix");
check(
	[1, 2, 3].toSpliced(1, undefined).join() === "1,2,3",
	"undefined delete count keeps suffix",
);
check([1].with()[0] === undefined, "omitted replacement stores undefined");

for (const index of [-4, 3, Infinity, -Infinity, "Infinity", "-Infinity"]) {
	let threw = false;
	try {
		[1, 2, 3].with(index, 9);
	} catch (error) {
		threw = error instanceof RangeError;
	}
	check(threw, "out of range with throws");
}

for (const operation of [
	() => [1, 2, 3].with(1n, 9),
	() => [1, 2, 3].slice(1n),
	() => [1, 2, 3].slice(0, 1n),
	() => [1, 2, 3].toSpliced(1n),
	() => [1, 2, 3].toSpliced(0, 1n),
	() => [].slice(0n),
	() => [].toSpliced(0, 0n),
]) {
	let threw = false;
	try {
		operation();
	} catch (error) {
		threw = error instanceof TypeError;
	}
	check(threw, "copy bounds reject BigInt through ToNumber");
}

let replacementEffects = 0;
let replacementThrew = false;
try {
	[1, 2, 3].with(1n, (replacementEffects++, 9));
} catch (error) {
	replacementThrew = error instanceof TypeError;
}
check(
	replacementThrew && replacementEffects === 1,
	"throwing with preserves replacement argument effects",
);

const mutated = [1, 2, 3];
check(
	mutated.toReversed((mutated[0] = 8)).join() === "3,2,8",
	"extra arguments precede copying",
);
const coercible = [1, 2, 3];
const index = {
	valueOf() {
		coercible[0] = 7;
		return 1;
	},
};
check(
	coercible.with(index, 9).join() === "7,9,3",
	"index coercion precedes copied reads",
);

const sliceEffects = [];
const sliceSource = [1, 2, 3];
sliceSource.constructor = {
	get [Symbol.species]() {
		sliceEffects.push("species");
		return Array;
	},
};
const sliceStart = {
	valueOf() {
		sliceEffects.push("start");
		sliceSource.push(4);
		sliceSource[0] = 7;
		return 0;
	},
};
const sliceEnd = {
	valueOf() {
		sliceEffects.push("end");
		sliceSource[1] = 8;
		return Infinity;
	},
};
check(
	sliceSource.slice(sliceStart, sliceEnd).join() === "7,8,3" &&
		sliceEffects.join() === "start,end,species",
	"slice captures length before bound coercion and reads species after both bounds",
);

const spliceEffects = [];
const spliceSource = [1, 2, 3];
const spliceStart = {
	valueOf() {
		spliceEffects.push("start");
		spliceSource.push(4);
		spliceSource[0] = 7;
		return 1;
	},
};
const spliceCount = {
	valueOf() {
		spliceEffects.push("count");
		spliceSource[2] = 8;
		return 1;
	},
};
check(
	spliceSource.toSpliced(spliceStart, spliceCount, 9).join() === "7,9,8" &&
		spliceEffects.join() === "start,count",
	"toSpliced captures length before ordered coercion and reads retained elements afterward",
);
check(Array.of(1, 2, 3).includes(2), "factory feeds static search");
check([1, 2, 3].toReversed().includes(2), "reverse feeds static search");
check([1, 2, 3].with(0, 9).includes(9), "replacement feeds static search");
check([1, 2, 3].toSpliced(1, 1, 9).includes(9), "insertion feeds static search");
check([1, 2, 3].slice(1).includes(2), "slice feeds static search");
check([1, 2].concat([3], 4).includes(4), "concat feeds static search");
const concatenated = concat(child);
check(concatenated !== concat(child), "concat result shells are fresh");
check(
	concatenated.length === 8 &&
		concatenated[0] === child &&
		concatenated[3] === child &&
		concatenated[6] === "ab" &&
		concatenated[7] === null,
	"concat retains shallow aliases and appends primitive strings as single values",
);
check(
	!Object.hasOwn(concatenated, 1) && !Object.hasOwn(concatenated, 4),
	"concat retains holes from both segments",
);
const appendedObject = [].concat(child, child);
check(
	appendedObject[0] === child && appendedObject[1] === child,
	"concat appends ordinary non-array objects without cloning",
);
const concatMutation = [1, 2];
check(
	concatMutation.concat(((concatMutation[0] = 7), [3])).join() === "7,2,3",
	"concat evaluates arguments before reading source elements",
);
const nonspread = [1, 2];
nonspread[Symbol.isConcatSpreadable] = false;
const nonspreadResult = [0].concat(nonspread);
check(
	nonspreadResult.length === 2 && nonspreadResult[1] === nonspread,
	"concat respects an array's explicit non-spreadability",
);
const concatEvents = [];
const protocolSource = [1];
protocolSource.constructor = {
	get [Symbol.species]() {
		concatEvents.push("species");
		return Array;
	},
};
Object.defineProperty(protocolSource, Symbol.isConcatSpreadable, {
	get() {
		concatEvents.push("receiver");
		return true;
	},
});
const protocolSegment = {
	get [Symbol.isConcatSpreadable]() {
		concatEvents.push("spread");
		return true;
	},
	get length() {
		concatEvents.push("length");
		return 2;
	},
	get 0() {
		concatEvents.push("element");
		return 9;
	},
};
const protocolResult = protocolSource.concat(protocolSegment);
check(
	protocolResult.length === 3 &&
		protocolResult[1] === 9 &&
		!Object.hasOwn(protocolResult, 2) &&
		concatEvents.join() === "species,receiver,spread,length,element",
	"concat preserves species, spreadability, length and element read ordering",
);
const laterSegment = [2];
const getterSegment = [1];
Object.defineProperty(getterSegment, 0, {
	get() {
		laterSegment[0] = 8;
		return 1;
	},
});
check(
	getterSegment.concat(laterSegment).join() === "1,8",
	"concat reads later segments after earlier getters can mutate them",
);
let concatProxyReads = 0;
const concatProxy = new Proxy([2], {
	get(target, key, receiver) {
		concatProxyReads++;
		return Reflect.get(target, key, receiver);
	},
});
check(
	[1].concat(concatProxy).join() === "1,2" && concatProxyReads === 3,
	"concat retains proxy spreadability, length and indexed reads",
);
const nestedChild = [1, , 2];
const flattened = flat(nestedChild);
check(
	flattened !== flat(nestedChild) &&
		flattened.length === 2 &&
		flattened[0] === nestedChild &&
		flattened[1] === nestedChild &&
		Object.hasOwn(flattened, 0) &&
		Object.hasOwn(flattened, 1),
	"flat at zero depth removes outer holes while preserving nested array aliases",
);
check([, ,].flat(0).length === 0, "flat removes arrays consisting only of holes");
for (const depth of [-0.9, -1, -Infinity, NaN, null, false, "invalid", "-1"]) {
	const result = [, nestedChild, ,].flat(depth);
	check(
		result.length === 1 && result[0] === nestedChild,
		"flat converts nonpositive depths without traversing nested arrays",
	);
}
check(
	[nestedChild].flat().join() === "1,2" && [nestedChild].flat(undefined).join() === "1,2",
	"flat defaults omitted and undefined depths to one",
);
let flatSpreadReads = 0;
Object.defineProperty(nestedChild, Symbol.isConcatSpreadable, {
	get() {
		flatSpreadReads++;
		return false;
	},
});
check(
	[nestedChild].flat(0)[0] === nestedChild &&
		[nestedChild].flat().join() === "1,2" &&
		flatSpreadReads === 0,
	"flat uses array identity without reading concat spreadability",
);
const flatEvents = [];
const flatSource = [1, , 3];
flatSource.constructor = {
	get [Symbol.species]() {
		flatEvents.push("species");
		return Array;
	},
};
const flatDepth = {
	valueOf() {
		flatEvents.push("depth");
		flatSource[1] = 2;
		flatSource.push(4);
		return 0;
	},
};
check(
	flatSource.flat(flatDepth).join() === "1,2,3" && flatEvents.join() === "depth,species",
	"flat captures length before depth coercion and creates species before reading elements",
);
let flatBigIntThrew = false;
try {
	[1].flat(0n);
} catch (error) {
	flatBigIntThrew = error instanceof TypeError;
}
check(flatBigIntThrew, "flat rejects BigInt depths through ToNumber");
check([, 1, , 2].flat(0).includes(2), "flat feeds static search");
const flatLeaf = [1, , child];
const flatBranch = [, flatLeaf, , 2];
const recursiveRoot = [, flatBranch, , flatLeaf];
const oneLevel = recursiveRoot.flat();
check(
	oneLevel.length === 4 &&
		oneLevel[0] === flatLeaf &&
		oneLevel[1] === 2 &&
		oneLevel[2] === 1 &&
		oneLevel[3] === child &&
		!Object.hasOwn(oneLevel[0], 1),
	"flat removes holes only in visited arrays and retains deeper sparse array identity",
);
const twoLevels = recursiveRoot.flat(2);
check(
	twoLevels !== recursiveRoot.flat(2) &&
		twoLevels.length === 5 &&
		twoLevels[0] === 1 &&
		twoLevels[1] === child &&
		twoLevels[2] === 2 &&
		twoLevels[3] === 1 &&
		twoLevels[4] === child,
	"flat creates fresh shells and preserves repeated non-array aliases across multiple depths",
);
check(
	[[], [, [[], [1, , [2]]]], []].flat(Infinity).join() === "1,2",
	"flat at infinite depth traverses bounded nested empty and sparse arrays",
);
let childConstructorReads = 0;
const speciesChild = [1, [2]];
Object.defineProperty(speciesChild, "constructor", {
	get() {
		childConstructorReads++;
		throw new Error("child constructor must not be read");
	},
});
check(
	[speciesChild].flat(Infinity).join() === "1,2" && childConstructorReads === 0,
	"recursive flat selects species only for the root result",
);
const flatLater = [2];
const flatEarlier = [1];
Object.defineProperty(flatEarlier, 0, {
	get() {
		flatLater[0] = 9;
		return 1;
	},
});
check(
	[flatEarlier, flatLater].flat().join() === "1,9",
	"flat visits later child arrays after earlier element getters can mutate them",
);
const flatCoercedChild = [1];
const nestedDepth = {
	valueOf() {
		flatCoercedChild[0] = 7;
		return 1;
	},
};
check(
	[flatCoercedChild].flat(nestedDepth)[0] === 7,
	"flat reads nested child contents after depth coercion",
);
let flatProxyGets = 0;
let flatProxyHas = 0;
const flatProxy = new Proxy([1, , 3], {
	get(target, key, receiver) {
		flatProxyGets++;
		return Reflect.get(target, key, receiver);
	},
	has(target, key) {
		flatProxyHas++;
		return Reflect.has(target, key);
	},
});
check(
	[flatProxy].flat().join() === "1,3" && flatProxyGets === 3 && flatProxyHas === 3,
	"flat preserves nested proxy length, presence and element reads",
);
const revokedFlatChild = Proxy.revocable([], {});
revokedFlatChild.revoke();
check(
	[revokedFlatChild.proxy].flat(0)[0] === revokedFlatChild.proxy,
	"flat skips child array classification when depth is exhausted",
);
let revokedFlatThrew = false;
try {
	[revokedFlatChild.proxy].flat();
} catch (error) {
	revokedFlatThrew = error instanceof TypeError;
}
check(revokedFlatThrew, "flat preserves revoked proxy array classification errors");
const flatCycle = [];
flatCycle.push(flatCycle, 1);
const finiteCycle = flatCycle.flat(1);
check(
	finiteCycle.length === 3 &&
		finiteCycle[0] === flatCycle &&
		finiteCycle[1] === 1 &&
		finiteCycle[2] === 1,
	"flat retains cyclic child identity when a finite depth is exhausted",
);
const flatInheritedPrototype = Object.create(Array.prototype);
flatInheritedPrototype[0] = 9;
const flatInheritedChild = [,];
Object.setPrototypeOf(flatInheritedChild, flatInheritedPrototype);
check(
	[flatInheritedChild].flat().join() === "9",
	"flat includes inherited numeric values in nested arrays",
);
check([[1, , 2], , [3]].flat().includes(2), "recursive flat feeds static search");
function storedChildMutation(update) {
	const inner = [1, 2];
	const outer = [inner];
	update(outer);
	return inner[0];
}
check(
	storedChildMutation((outer) => {
		outer[0][0] = 9;
	}) === 9,
	"storing a child retains later callback mutation",
);
function storedChildLengthConversion() {
	const inner = [1];
	const outer = [inner];
	Object.defineProperty(outer, "length", {
		value: {
			valueOf() {
				inner[0] = 7;
				return 1;
			},
		},
	});
	return inner[0];
}
check(
	storedChildLengthConversion() === 7,
	"a different array's length conversion can mutate a stored child",
);
function storedChildKeyConversion() {
	const inner = [1];
	const outer = [inner];
	Object.defineProperty(
		outer,
		{
			toString() {
				inner[0] = 8;
				return "next";
			},
		},
		{ value: inner },
	);
	return inner[0];
}
check(
	storedChildKeyConversion() === 8,
	"computed property keys can mutate a stored child before its definition",
);
console.log("static-array-copies PASS");
