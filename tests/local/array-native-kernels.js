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
	let setIteratorGets = 0;
	const iterableSet = new Set([10, 20, 30]);
	Object.defineProperty(iterableSet, Symbol.iterator, {
		configurable: true,
		get() {
			setIteratorGets++;
			return Set.prototype.values;
		},
	});
	check(
		"Array.from observes Set iterator Get once",
		Array.from(iterableSet).join() === "10,20,30" && setIteratorGets === 1,
	);
	let capturedIteratorGets = 0;
	const capturedIteratorSource = new Set([11, 22]);
	Object.defineProperty(capturedIteratorSource, Symbol.iterator, {
		configurable: true,
		get() {
			capturedIteratorGets++;
			return Set.prototype.values;
		},
	});
	function ReplacingArrayFromConstructor() {
		Object.defineProperty(capturedIteratorSource, Symbol.iterator, {
			configurable: true,
			value: function* () {
				yield 99;
			},
		});
	}
	const capturedIteratorResult = Array.from.call(
		ReplacingArrayFromConstructor,
		capturedIteratorSource,
	);
	check(
		"Array.from uses iterator method captured before construction",
		capturedIteratorGets === 1 &&
			capturedIteratorResult.length === 2 &&
			capturedIteratorResult[0] === 11 &&
			capturedIteratorResult[1] === 22,
	);
	const orderedSet = new Set([1, 2, 3]);
	orderedSet.delete(2);
	orderedSet.add(2);
	const objectKey = { id: 4 };
	orderedSet.add(objectKey);
	const orderedCopy = Array.from(orderedSet);
	check(
		"Array.from drains Set values in insertion order",
		orderedCopy.length === 4 &&
			orderedCopy[0] === 1 &&
			orderedCopy[1] === 3 &&
			orderedCopy[2] === 2 &&
			orderedCopy[3] === objectKey,
	);
	let escapedSetIterator;
	const escapedIteratorSource = {
		[Symbol.iterator]() {
			escapedSetIterator = orderedSet.values();
			return escapedSetIterator;
		},
	};
	check(
		"Array.from exhausts an escaped exact Set iterator",
		Array.from(escapedIteratorSource).length === 4 && escapedSetIterator.next().done,
	);
	const mutatedSet = new Set([1, 2, 3]);
	const mutatedCopy = Array.from(mutatedSet, (value, index) => {
		if (index === 0) {
			mutatedSet.delete(2);
			mutatedSet.add(4);
		}
		return value;
	});
	check("Array.from mapper observes Set mutation", mutatedCopy.join() === "1,3,4");
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
	const mapperReceiver = { offset: 5 };
	const mapperCalls = [];
	const mappedArrayLike = Array.from(
		{ 0: 10, 1: 20, length: 2 },
		function (value, index) {
			mapperCalls.push([this, value, index]);
			return value + index + this.offset;
		},
		mapperReceiver,
	);
	check(
		"Array.from mapper preserves receiver and arguments",
		mappedArrayLike.join() === "15,26" &&
			mapperCalls.length === 2 &&
			mapperCalls[0][0] === mapperReceiver &&
			mapperCalls[0][1] === 10 &&
			mapperCalls[0][2] === 0 &&
			mapperCalls[1][1] === 20 &&
			mapperCalls[1][2] === 1,
	);
	const asyncCopy = await Array.fromAsync([1, 2, 3], async (value) => value + 4);
	check("Array.fromAsync", asyncCopy.join() === "5,6,7");

	const source = [1, 2, 3, 4, 5];
	let forEachSum = 0;
	source.forEach((value) => (forEachSum += value));
	check("map", source.map((value) => value * 2).join() === "2,4,6,8,10");
	check("forEach", forEachSum === 15);
	check("filter", source.filter((value) => (value & 1) === 1).join() === "1,3,5");
	const mutableFilterSource = [1, , 3, 4];
	let filterVisits = 0;
	const mutableFiltered = mutableFilterSource.filter((value, index, receiver) => {
		filterVisits++;
		if (index === 0) delete receiver[3];
		return value !== 1;
	});
	check(
		"filter compacts selections while observing source mutation",
		filterVisits === 2 && mutableFiltered.join() === "3",
	);
	let exposedFilterResult;
	class FilterSource extends Array {
		static get [Symbol.species]() {
			return class extends Array {
				constructor(length) {
					super(length);
					exposedFilterResult = this;
				}
			};
		}
	}
	const speciesFiltered = new FilterSource(1, 2).filter((value, index) => {
		if (index === 0) exposedFilterResult.push(99);
		return true;
	});
	check(
		"filter custom species result remains observable during callbacks",
		speciesFiltered.join() === "1,2",
	);
	const filterFailure = {};
	let filterGetterCallbacks = 0;
	const throwingFilterSource = new Proxy([1, 2, 3], {
		get(target, key, receiver) {
			if (key === "1") throw filterFailure;
			return Reflect.get(target, key, receiver);
		},
	});
	let caughtFilterFailure;
	try {
		throwingFilterSource.filter(() => {
			filterGetterCallbacks++;
			return true;
		});
	} catch (error) {
		caughtFilterFailure = error;
	}
	check(
		"filter stops after an abrupt indexed Get",
		caughtFilterFailure === filterFailure && filterGetterCallbacks === 1,
	);
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
	const flatWithHoles = [1, [2, , 3], , [4, 5]].flat();
	check(
		"flat dense depth one compacts outer and nested holes",
		flatWithHoles.length === 5 &&
			flatWithHoles.join() === "1,2,3,4,5" &&
			Object.keys(flatWithHoles).length === 5,
	);
	const speciesNested = [6, 7, 8];
	const speciesFlatSource = [speciesNested, 9];
	speciesFlatSource.constructor = {
		get [Symbol.species]() {
			speciesNested[0] = 10;
			delete speciesNested[1];
			return Array;
		},
	};
	check(
		"flat revalidates dense children after species effects",
		speciesFlatSource.flat().join() === "10,8,9",
	);
	let flatProxyHas = 0;
	let flatProxyGet = 0;
	const flatProxyChild = new Proxy([11, , 12], {
		has(target, key) {
			flatProxyHas++;
			return Reflect.has(target, key);
		},
		get(target, key, receiver) {
			flatProxyGet++;
			return Reflect.get(target, key, receiver);
		},
	});
	check(
		"flat falls back for proxy array children",
		[flatProxyChild].flat().join() === "11,12" && flatProxyHas >= 3 && flatProxyGet >= 3,
	);
	check("flatMap", source.flatMap((value) => [value, -value]).length === 10);
	const flatMappedHoles = [1, 2].flatMap((value) =>
		value === 1 ? [value, , value + 10] : [, value],
	);
	check(
		"flatMap dense mapped arrays compact holes",
		flatMappedHoles.length === 3 &&
			flatMappedHoles.join() === "1,11,2" &&
			Object.keys(flatMappedHoles).length === 3,
	);
	let exposedFlatMapResult;
	const aliasFlatMapSource = [1, 2];
	aliasFlatMapSource.constructor = {
		[Symbol.species]: function () {
			exposedFlatMapResult = [];
			return exposedFlatMapResult;
		},
	};
	const aliasedFlatMap = aliasFlatMapSource.flatMap((value, index) =>
		index === 0 ? [value] : exposedFlatMapResult,
	);
	check(
		"flatMap snapshots an aliased mapped result extent",
		aliasedFlatMap === exposedFlatMapResult && aliasedFlatMap.join() === "1,1",
	);
	let flatMapProxyHas = 0;
	let flatMapProxyGet = 0;
	const flatMapProxyChild = new Proxy([3, , 4], {
		has(target, key) {
			flatMapProxyHas++;
			return Reflect.has(target, key);
		},
		get(target, key, receiver) {
			flatMapProxyGet++;
			return Reflect.get(target, key, receiver);
		},
	});
	check(
		"flatMap falls back for proxy mapped arrays",
		[0].flatMap(() => flatMapProxyChild).join() === "3,4" &&
			flatMapProxyHas >= 3 &&
			flatMapProxyGet >= 3,
	);

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
	let emptySearchCoercions = 0;
	const emptySearchFromIndex = {
		valueOf() {
			emptySearchCoercions++;
			throw new Error("empty search coerced fromIndex");
		},
	};
	check(
		"empty searches do not coerce fromIndex",
		[].includes(1, emptySearchFromIndex) === false &&
			[].indexOf(1, emptySearchFromIndex) === -1 &&
			[].lastIndexOf(1, emptySearchFromIndex) === -1 &&
			emptySearchCoercions === 0,
	);
	const mixedNumericSearch = [0, -0, 1.5, NaN, Infinity, 1n, "1", { value: 1 }];
	check(
		"dense numeric searches preserve Number identity and type boundaries",
		mixedNumericSearch.indexOf(-0) === 0 &&
			mixedNumericSearch.lastIndexOf(0) === 1 &&
			mixedNumericSearch.indexOf(1.5) === 2 &&
			mixedNumericSearch.indexOf(NaN) === -1 &&
			mixedNumericSearch.includes(NaN) &&
			mixedNumericSearch.includes(Infinity) &&
			mixedNumericSearch.indexOf(1) === -1 &&
			[1, 2, 1].lastIndexOf(1, undefined) === 0 &&
			[1, 2, 1].lastIndexOf(1, Infinity) === 2 &&
			[1, 2, 1].lastIndexOf(1, -Infinity) === -1,
	);
	const searchMutation = [1, 2, 3];
	const mutatingFromIndex = {
		valueOf() {
			searchMutation[0] = 9;
			return 0;
		},
	};
	check(
		"dense numeric searches observe fromIndex coercion before scanning",
		searchMutation.includes(9, mutatingFromIndex) &&
			searchMutation.indexOf(9, mutatingFromIndex) === 0 &&
			searchMutation.lastIndexOf(9, mutatingFromIndex) === 0,
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
	let numericJoinSeparatorCoercions = 0;
	const numericJoinSeparator = {
		toString() {
			numericJoinSeparatorCoercions++;
			return " | ";
		},
	};
	let numericJoinFallbackCoercions = 0;
	const numericJoinFallback = {
		toString() {
			numericJoinFallbackCoercions++;
			return "object";
		},
	};
	check(
		"join formats dense int32 values and preserves generic numeric fallbacks",
		[-2147483648, -1024, -1, 0, 1, 1024, 2147483647].join(numericJoinSeparator) ===
			"-2147483648 | -1024 | -1 | 0 | 1 | 1024 | 2147483647" &&
			numericJoinSeparatorCoercions === 1 &&
			[-0, 0, 0.5, NaN, Infinity, -Infinity].join(":") ===
				"0:0:0.5:NaN:Infinity:-Infinity" &&
			[1, numericJoinFallback, 3].join(":") === "1:object:3" &&
			numericJoinFallbackCoercions === 1,
	);
	let deepRope = "rope";
	for (let index = 0; index < 128; index++) {
		deepRope += String.fromCharCode(65 + (index % 26));
	}
	const ropeJoined = ["prefix", deepRope, "\ud83d\ude00", "suffix"].join("|");
	check(
		"join copies rope leaves into the result",
		ropeJoined.length === deepRope.length + 17 &&
			ropeJoined.startsWith("prefix|ropeA") &&
			ropeJoined.endsWith("|\ud83d\ude00|suffix"),
	);
	const reversed = [1, , 3, 4];
	reversed.reverse();
	check(
		"reverse preserves holes",
		reversed.length === 4 && reversed[0] === 4 && !(2 in reversed) && reversed[3] === 1,
	);
	class StopWideReverse extends Error {}
	let wideReverseGets = 0;
	const wideReverse = {
		get 9007199254740990() {
			wideReverseGets++;
			throw new StopWideReverse();
		},
		length: 2 ** 53 + 2,
	};
	check(
		"reverse observes ToLength indices above uint32",
		throws(StopWideReverse, () => Array.prototype.reverse.call(wideReverse)) &&
			wideReverseGets === 1,
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
	const primitiveStringSorted = ["pear", "apple", "orange", "banana", "plum", "grape"];
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
