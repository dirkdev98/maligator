const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function throws(error, fn) {
	try {
		fn();
		return false;
	} catch (thrown) {
		return thrown instanceof error;
	}
}

async function main() {
	const holes = new Array(3);
	const constructed = Array(1, 2, 3);
	check(
		"Array constructor length and values",
		holes.length === 3 && !(0 in holes) && constructed.join() === "1,2,3",
	);
	check("Array.isArray", Array.isArray(constructed) && !Array.isArray({ length: 3 }));
	check("Array.of", Array.of(4, 5, 6).join() === "4,5,6");

	let iteratorGets = 0;
	const iterable = [7, 8, 9];
	Object.defineProperty(iterable, Symbol.iterator, {
		configurable: true,
		get() {
			iteratorGets++;
			return Array.prototype.values;
		},
	});
	check(
		"Array.from observes iterator Get",
		Array.from(iterable).join() === "7,8,9" && iteratorGets === 1,
	);
	const fromHoles = Array.from([, 1]);
	check(
		"Array.from materializes iterator holes",
		0 in fromHoles && fromHoles[0] === undefined && fromHoles[1] === 1,
	);
	const badIterator = [1];
	badIterator[Symbol.iterator] = 1;
	check(
		"Array.from rejects non-callable iterator",
		throws(TypeError, () => Array.from(badIterator)),
	);
	let lengthGets = 0;
	const arrayLike = {
		0: 3,
		1: 4,
		get length() {
			lengthGets++;
			return 2;
		},
	};
	check(
		"Array.from array-like length getter",
		Array.from(arrayLike, (value) => value * 2).join() === "6,8" && lengthGets === 1,
	);
	const asyncCopy = await Array.fromAsync([1, 2, 3], async (value) => value + 4);
	check("Array.fromAsync", asyncCopy.join() === "5,6,7");

	const source = [1, 2, 3, 4, 5];
	let forEachSum = 0;
	source.forEach((value) => (forEachSum += value));
	check("map", source.map((value) => value * 2).join() === "2,4,6,8,10");
	check("forEach", forEachSum === 15);
	check("filter", source.filter((value) => (value & 1) === 1).join() === "1,3,5");
	check("reduce", source.reduce((sum, value) => sum + value, 0) === 15);
	check("reduceRight", source.reduceRight((sum, value) => sum * 10 + value, 0) === 54321);
	check("find", source.find((value) => value > 3) === 4);
	check("findIndex", source.findIndex((value) => value > 3) === 3);
	check("findLast", source.findLast((value) => value < 5) === 4);
	check("findLastIndex", source.findLastIndex((value) => value < 5) === 3);
	check(
		"some",
		source.some((value) => value === 4),
	);
	check(
		"every",
		source.every((value) => value < 6),
	);
	check("flat", [1, [2, [3]]].flat(2).join() === "1,2,3");
	check("flatMap", source.flatMap((value) => [value, -value]).length === 10);

	check("indexOf", source.indexOf(3) === 2);
	check("lastIndexOf", [1, 2, 1].lastIndexOf(1) === 2);
	check("includes", [, 2].includes(undefined) && source.includes(4));
	const denseSearch = [NaN, 1, , 2, 1, NaN];
	check(
		"dense searches preserve holes, offsets, and equality modes",
		denseSearch.indexOf(NaN) === -1 &&
			denseSearch.indexOf(1, 2) === 4 &&
			denseSearch.lastIndexOf(1, -2) === 4 &&
			denseSearch.includes(NaN) &&
			denseSearch.includes(undefined),
	);

	const pushed = [1, 2, 3];
	check("push", pushed.push(4, 5) === 5 && pushed.join() === "1,2,3,4,5");
	check("pop", pushed.pop() === 5 && pushed.join() === "1,2,3,4");
	check("shift", pushed.shift() === 1 && pushed.join() === "2,3,4");
	check("unshift", pushed.unshift(8, 9) === 5 && pushed.join() === "8,9,2,3,4");

	const slicedHole = [, 1].slice();
	check(
		"slice preserves holes",
		slicedHole.length === 2 && !(0 in slicedHole) && slicedHole[1] === 1,
	);
	check("concat", [1, 2].concat([3, 4], 5).join() === "1,2,3,4,5");
	const concatenatedHole = [0].concat([, 2]);
	check(
		"concat preserves holes",
		concatenatedHole.length === 3 &&
			concatenatedHole[0] === 0 &&
			!(1 in concatenatedHole) &&
			concatenatedHole[2] === 2,
	);
	const shrinkingSlice = [1, 2, 3];
	shrinkingSlice.constructor = {
		get [Symbol.species]() {
			shrinkingSlice.length = 1;
			return Array;
		},
	};
	const shrunkSlice = shrinkingSlice.slice(0, 3);
	check(
		"slice revalidates after species side effects",
		shrunkSlice.length === 3 &&
			shrunkSlice[0] === 1 &&
			!(1 in shrunkSlice) &&
			!(2 in shrunkSlice),
	);
	check("join", [1, null, undefined, 4].join(":") === "1:::4");
	check(
		"join dense strings, nullish values, and holes",
		["alpha", "beta", null, "gamma", undefined, "delta"].join(":") ===
			"alpha:beta::gamma::delta" &&
			["a", , "b"].join() === "a,,b" &&
			["", "only", ""].join("") === "only",
	);
	const reversed = [1, , 3, 4];
	reversed.reverse();
	check(
		"reverse preserves holes",
		reversed.length === 4 && reversed[0] === 4 && !(2 in reversed) && reversed[3] === 1,
	);
	const filled = [1, , 3, 4];
	filled.fill(7, 1, 3);
	check("fill", filled.join() === "1,7,7,4");
	check("at", source.at(-2) === 4);

	const defaultSorted = [10, 2, undefined, 1, , 20];
	defaultSorted.sort();
	check(
		"sort default order and holes",
		defaultSorted[0] === 1 &&
			defaultSorted[1] === 10 &&
			defaultSorted[2] === 2 &&
			defaultSorted[3] === 20 &&
			defaultSorted[4] === undefined &&
			!(5 in defaultSorted),
	);
	const mixedPrimitiveSorted = [true, null, false, 10, 2, 1n];
	mixedPrimitiveSorted.sort();
	check(
		"sort reuses non-observable primitive string keys",
		mixedPrimitiveSorted.map((value) => String(value)).join(",") ===
			"1,10,2,false,null,true",
	);
	const primitiveStringSorted = [
		"pear",
		"apple",
		"orange",
		"banana",
		"plum",
		"grape",
	];
	primitiveStringSorted.sort();
	check(
		"sort compares primitive strings directly",
		primitiveStringSorted.join(",") === "apple,banana,grape,orange,pear,plum",
	);
	let compareCoercions = 0;
	const comparatorSorted = [3, 1, 2];
	comparatorSorted.sort((left, right) => ({
		valueOf() {
			compareCoercions++;
			return left - right;
		},
	}));
	check(
		"sort comparator ToNumber",
		comparatorSorted.join() === "1,2,3" && compareCoercions > 0,
	);
	let stringCoercions = 0;
	const objectSorted = [
		{
			toString() {
				stringCoercions++;
				return "b";
			},
		},
		{
			toString() {
				stringCoercions++;
				return "a";
			},
		},
	];
	objectSorted.sort();
	check(
		"sort default ToString",
		objectSorted[0].toString() === "a" && stringCoercions >= 3,
	);

	const spliced = [1, 2, 3, 4, 5];
	const removed = spliced.splice(1, 3, 8, 9);
	check("splice", removed.join() === "2,3,4" && spliced.join() === "1,8,9,5");
	const copiedWithin = [1, 2, 3, 4, 5];
	copiedWithin.copyWithin(1, 3);
	check("copyWithin", copiedWithin.join() === "1,4,5,4,5");
	check("with", source.with(2, 9).join() === "1,2,9,4,5");
	const withHole = [, 1].with(1, 2);
	check(
		"with materializes holes",
		0 in withHole && withHole[0] === undefined && withHole[1] === 2,
	);
	const copyHole = [, 1].toReversed();
	check(
		"toReversed densifies holes",
		copyHole.length === 2 &&
			copyHole[0] === 1 &&
			1 in copyHole &&
			copyHole[1] === undefined,
	);
	check("toSorted", [3, 1, 2].toSorted((a, b) => a - b).join() === "1,2,3");
	check("toSpliced", source.toSpliced(1, 2, 8, 9).join() === "1,8,9,4,5");
	const splicedHole = [, 1].toSpliced(1, 0, 2);
	check(
		"toSpliced materializes copied holes",
		0 in splicedHole && splicedHole[0] === undefined && splicedHole.join() === ",2,1",
	);
	check("toString", [1, 2, 3].toString() === "1,2,3");
	check("toLocaleString", [1, 2, 3].toLocaleString() === "1,2,3");

	check("keys", Array.from(source.keys()).join() === "0,1,2,3,4");
	check("values", Array.from(source.values()).join() === "1,2,3,4,5");
	check(
		"entries",
		Array.from(source.entries())
			.map((entry) => entry.join(":"))
			.join() === "0:1,1:2,2:3,3:4,4:5",
	);

	const nonExtensibleReverse = [, 1];
	Object.preventExtensions(nonExtensibleReverse);
	check(
		"reverse non-extensible hole throws",
		throws(TypeError, () => nonExtensibleReverse.reverse()),
	);
	const nonExtensibleFill = [, 1];
	Object.preventExtensions(nonExtensibleFill);
	check(
		"fill non-extensible hole throws",
		throws(TypeError, () => nonExtensibleFill.fill(3)),
	);
	const nonExtensibleShift = [, 1];
	Object.preventExtensions(nonExtensibleShift);
	check(
		"shift non-extensible hole throws",
		throws(TypeError, () => nonExtensibleShift.shift()),
	);

	Array.prototype[1] = 41;
	const inheritedHole = new Array(3);
	check(
		"prototype indexed value remains observable",
		inheritedHole.map((value) => value)[1] === 41 && inheritedHole.includes(41),
	);
	delete Array.prototype[1];

	for (const [name, passed] of results) {
		if (!passed) console.log("FAIL: " + name);
	}
	console.log(
		"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
	);
}

main().catch((error) => {
	console.log("FAIL: " + error);
	console.log("RESULT 0/1");
});
