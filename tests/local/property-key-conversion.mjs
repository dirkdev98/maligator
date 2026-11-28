// Keyed operations turn each key into a property key once per execution. String
// constants and other atoms are their own keys, so each scenario warms its sites
// with them and then mixes in keys that must still convert: index-like strings,
// "-0" and other numeric-looking names, symbols, fresh strings and objects with
// toString, valueOf or Symbol.toPrimitive, whose hooks run once per conversion.
const log = [];

function record(label, read) {
	try {
		log.push(`${label}: ${JSON.stringify(read())}`);
	} catch (error) {
		log.push(`${label}: ${error.constructor.name}`);
	}
}

function churn() {
	const garbage = [];
	for (let i = 0; i < 300; i++) garbage.push({ i, text: `item-${i}` });
	globalThis.gc?.();
	return garbage.length;
}

function read(object, key) {
	return object[key];
}

function write(object, key, value) {
	object[key] = value;
	return object;
}

function has(object, key) {
	return key in object;
}

function remove(object, key) {
	return delete object[key];
}

function bump(object, key) {
	object[key] += 1;
	return object[key];
}

function owns(object, key) {
	return Object.prototype.hasOwnProperty.call(object, key);
}

const names = ["alpha", "beta", "gamma", "delta", "__proto__", "length"];
const indexLike = [
	"0",
	"1",
	"7",
	"4294967294",
	"4294967295",
	"01",
	"1.0",
	"-0",
	"-1",
	"NaN",
];

function counted(label, result) {
	const calls = [];
	return {
		calls,
		key: {
			toString() {
				calls.push(`${label}.toString`);
				return result;
			},
			valueOf() {
				calls.push(`${label}.valueOf`);
				return 99;
			},
		},
	};
}

function primitiveKey(result) {
	const calls = [];
	return {
		calls,
		key: {
			[Symbol.toPrimitive](hint) {
				calls.push(hint);
				return result;
			},
		},
	};
}

function warmedConstantKeys() {
	const proto = { alpha: 1, beta: 2 };
	const objects = [Object.create(proto), { gamma: 3 }, { delta: 4, alpha: 5 }, []];
	const seen = [];
	for (let round = 0; round < 40; round++) {
		for (const object of objects) {
			for (const name of names) {
				if (name === "__proto__" || name === "length") continue;
				seen.push(read(object, name));
				write(object, name, round);
				seen.push(has(object, name), owns(object, name));
			}
		}
		if (round % 10 === 0) churn();
	}
	return [seen.length, seen.slice(-12), objects.map((object) => Object.keys(object))];
}

function indexLikeKeys() {
	const object = {};
	const array = [10, 20, 30];
	const typed = new Uint8Array(4);
	const results = [];
	for (let round = 0; round < 3; round++) {
		for (const key of indexLike) {
			write(object, key, `${key}:${round}`);
			write(array, key, round);
			write(typed, key, round + 1);
			results.push([
				key,
				read(object, key),
				read(array, key),
				read(typed, key),
				has(typed, key),
			]);
		}
		churn();
	}
	results.push(["object keys", Object.keys(object)]);
	results.push(["array length", array.length, Object.keys(array)]);
	results.push(["typed keys", Object.keys(typed), Array.from(typed)]);
	results.push([
		"number keys",
		read(object, 0),
		read(object, 1),
		read(object, -0),
		read(object, 4294967294),
	]);
	results.push([
		"deletes",
		remove(object, "1"),
		remove(array, "0"),
		has(array, "0"),
		array.length,
	]);
	results.push(["after delete", Object.keys(object)]);
	return results;
}

function freshStringKeys() {
	const object = { alpha: 1, gamma: 3 };
	const results = [];
	for (let round = 0; round < 60; round++) {
		const fresh = ["al", "pha"].join("");
		const built = `${"gam"}${"ma".repeat(1)}`;
		const index = String(round % 4);
		write(object, built, round);
		results.push(read(object, fresh), has(object, built), read(object, index));
		write(object, index, fresh);
		if (round % 20 === 0) churn();
	}
	return [results.slice(-9), Object.keys(object), object.gamma];
}

function symbolKeys() {
	const local = Symbol("local");
	const registered = Symbol.for("registered");
	const object = {};
	const results = [];
	for (let round = 0; round < 20; round++) {
		for (const key of [local, registered, Symbol.iterator, "alpha"]) {
			write(object, key, round);
			results.push(read(object, key), has(object, key), owns(object, key));
		}
	}
	results.push(
		remove(object, local),
		has(object, local),
		Object.getOwnPropertySymbols(object).length,
	);
	return results.slice(-8);
}

function coercedKeys() {
	const object = { alpha: 1, beta: 2 };
	const array = [5, 6, 7];
	const results = [];
	const string = counted("string", "alpha");
	results.push(read(object, string.key), string.calls.length);
	write(object, string.key, 11);
	results.push(object.alpha, string.calls.length);
	results.push(bump(object, "beta"), string.calls.length);
	results.push(has(object, string.key), owns(object, string.key), string.calls.length);
	results.push(remove(object, string.key), has(object, "alpha"), string.calls.length);

	const index = counted("index", "2");
	results.push(read(array, index.key), has(array, index.key), index.calls.length);
	write(array, index.key, 70);
	results.push(array[2], remove(array, index.key), array.length, index.calls.length);

	const symbol = Symbol("converted");
	const symbolic = primitiveKey(symbol);
	write(object, symbolic.key, "via symbol");
	results.push(object[symbol], has(object, symbolic.key), symbolic.calls);

	const minusZero = primitiveKey(-0);
	write(object, minusZero.key, "zero");
	results.push(object["0"], object["-0"], minusZero.calls);

	const proto = primitiveKey("__proto__");
	results.push(read(object, proto.key) === Object.prototype, proto.calls);

	const defined = counted("defined", "gamma");
	Object.defineProperty(object, defined.key, { value: 3, enumerable: true });
	results.push(
		Object.getOwnPropertyDescriptor(object, defined.key),
		Reflect.has(object, defined.key),
	);
	results.push(defined.calls);

	const throwing = {
		toString() {
			throw new RangeError("key");
		},
	};
	for (const operation of [read, has, remove, owns]) {
		try {
			operation(object, throwing);
			results.push("no throw");
		} catch (error) {
			results.push(error.constructor.name);
		}
	}
	try {
		write(object, throwing, 1);
		results.push("no throw");
	} catch (error) {
		results.push(error.constructor.name);
	}
	try {
		read(null, throwing);
		results.push("no throw");
	} catch (error) {
		results.push(error.constructor.name);
	}
	return [results, Object.keys(object)];
}

function protoKey() {
	const replacement = { inherited: "yes" };
	const object = {};
	write(object, "__proto__", replacement);
	const dictionary = Object.create(null);
	write(dictionary, "__proto__", 1);
	return [
		object.inherited,
		Object.getPrototypeOf(object) === replacement,
		owns(object, "__proto__"),
		read(dictionary, "__proto__"),
		Object.keys(dictionary),
	];
}

function main() {
	record("warmed constant keys", warmedConstantKeys);
	record("index-like keys", indexLikeKeys);
	record("fresh string keys", freshStringKeys);
	record("symbol keys", symbolKeys);
	record("coerced keys", coercedKeys);
	record("__proto__ key", protoKey);
	for (const line of log) console.log(line);
}

main();
