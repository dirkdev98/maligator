"use strict";
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const kind = process.env.COLLECTION_FAMILY_KIND ?? "map";
const output = [];
let coercions = 0;
function check(value, message) {
	if (!value) throw new Error(message);
}
function invokeFamily(receiver, alternate, factor) {
	const log = [];
	const context = {};
	let current = receiver;
	for (let round = 0; round < 3; round++) {
		const result = current.forEach(function familyVisit(value, key, owner) {
			const count = arguments.length;
			const calculated = value * factor + key;
			log.push([String(calculated), owner === current, count, this === context]);
			collect();
			return calculated;
		}, context);
		log.push(result === undefined ? "undefined" : result);
		current = round === 0 ? alternate : receiver;
	}
	return log;
}
function recordFamily(receiver) {
	const log = [];
	receiver.forEach(function record(value, key, owner) {
		log.push([
			typeof value,
			String(value),
			typeof key,
			value === key,
			owner === receiver,
		]);
		collect();
	});
	return log;
}
function objectValues(receiver) {
	let total = 0;
	receiver.forEach(function objectScore(value, index) {
		total += value.score + index * 3;
		collect();
	});
	return total;
}
if (kind === "map") {
	const key = {
		valueOf() {
			coercions++;
			return 7;
		},
	};
	const first = new Map([
		["key", 2],
		[key, 3],
	]);
	const second = new Map([["other", 4]]);
	output.push(invokeFamily(first, second, 2));
	output.push(
		recordFamily(
			new Map([
				[{}, 4n],
				[Symbol("key"), "value"],
			]),
		),
	);
	check(coercions === 2, "map key coercion exactly once");
	output.push(
		objectValues(
			new Map([
				["2", { score: 4 }],
				["3", { score: 5 }],
			]),
		),
	);
} else if (kind === "set") {
	const value = {
		valueOf() {
			coercions++;
			return 5;
		},
		toString() {
			return "object";
		},
	};
	const first = new Set(["3", value]);
	const second = new Set(["4"]);
	output.push(invokeFamily(first, second, 2));
	output.push(recordFamily(new Set([4n, Symbol("value")])));
	check(coercions === 4, "set coercion count");
} else if (kind === "array") {
	output.push(invokeFamily([2, 3], [4], 2));
	output.push(recordFamily([4n, "value"]));
} else if (kind === "typed") {
	output.push(invokeFamily(new Float64Array([2, 3]), new Int16Array([4]), 2));
	output.push(recordFamily(new BigInt64Array([4n, 5n])));
} else if (kind === "array-object") {
	output.push(objectValues([{ score: 4 }, { score: 5 }]));
} else {
	const custom = {
		forEach(callback, context) {
			callback.call(context, 3, "custom", this, "extra");
			return 73;
		},
	};
	output.push(invokeFamily(custom, custom, 2));
	const wrongFamily = { 0: 2, length: 1, forEach: Array.prototype.map };
	output.push(invokeFamily(wrongFamily, wrongFamily, 2));
	let called = 0;
	const marker = {};
	const throwing = {
		valueOf() {
			called++;
			throw marker;
		},
	};
	try {
		invokeFamily(new Map([[throwing, 1]]), custom, 2);
		throw new Error("missing throw");
	} catch (error) {
		check(error === marker, "coercion throw identity");
	}
	check(called === 1, "coercion throw no replay");
	for (const forEach of [Map.prototype.forEach, Set.prototype.forEach]) {
		try {
			invokeFamily({ forEach }, custom, 2);
			throw new Error("missing brand error");
		} catch (error) {
			check(error instanceof TypeError, "borrowed brand error");
		}
	}
	const replacement = new Map([["first", 1]]);
	Object.defineProperty(replacement, "forEach", {
		configurable: true,
		value: Map.prototype.forEach,
	});
	function mutateMethod(receiver) {
		const results = [];
		for (let round = 0; round < 2; round++) {
			results.push(
				receiver.forEach(function changeMethod(value, key, owner) {
					check(owner === receiver, "receiver identity");
					Object.defineProperty(owner, "forEach", {
						configurable: true,
						value: custom.forEach,
					});
				}),
			);
		}
		return results;
	}
	output.push(mutateMethod(replacement));
}
output.push(coercions);
console.log(JSON.stringify(output));
