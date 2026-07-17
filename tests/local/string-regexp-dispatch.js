const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

function throwsTypeError(fn) {
	try {
		fn();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

const primitiveCases = [
	[BigInt.prototype, 1n, "a1b1c", "1", 1, 3],
	[Boolean.prototype, true, "atruebtruec", "true", 1, 6],
	[Number.prototype, 1, "a1b1c", "1", 1, 3],
	[String.prototype, ",", "a,b,c", ",", 1, 3],
];

for (const [prototype, value, source, text, firstIndex, secondIndex] of primitiveCases) {
	Object.defineProperty(prototype, Symbol.match, {
		configurable: true,
		get() {
			throw new Error("primitive Symbol.match getter called");
		},
	});
	const match = source.match(value);
	check(
		"match skips primitive symbol lookup",
		match[0] === text && match.index === firstIndex && match.input === source,
	);
	delete prototype[Symbol.match];

	Object.defineProperty(prototype, Symbol.matchAll, {
		configurable: true,
		get() {
			throw new Error("primitive Symbol.matchAll getter called");
		},
	});
	const matches = [...source.matchAll(value)];
	check(
		"matchAll skips primitive symbol lookup",
		matches.length === 2 &&
			matches[0][0] === text &&
			matches[0].index === firstIndex &&
			matches[1][0] === text &&
			matches[1].index === secondIndex,
	);
	delete prototype[Symbol.matchAll];

	Object.defineProperty(prototype, Symbol.search, {
		configurable: true,
		get() {
			throw new Error("primitive Symbol.search getter called");
		},
	});
	check("search skips primitive symbol lookup", source.search(value) === firstIndex);
	delete prototype[Symbol.search];
}

for (const [name, method, symbol] of [
	["match", String.prototype.match, Symbol.match],
	["matchAll", String.prototype.matchAll, Symbol.matchAll],
	["search", String.prototype.search, Symbol.search],
]) {
	const expected = {};
	let receivedThis;
	let receivedValue;
	const argument = {};
	argument[symbol] = function (value) {
		receivedThis = this;
		receivedValue = value;
		return expected;
	};
	check(
		name + " dispatches object symbol method",
		method.call("subject", argument) === expected &&
			receivedThis === argument &&
			receivedValue === "subject",
	);
}

for (const [name, method, symbol, args] of [
	["match", String.prototype.match, Symbol.match, []],
	["matchAll", String.prototype.matchAll, Symbol.matchAll, []],
	["search", String.prototype.search, Symbol.search, []],
	["replace", String.prototype.replace, Symbol.replace, ["x"]],
	["replaceAll", String.prototype.replaceAll, Symbol.replace, ["x"]],
	["split", String.prototype.split, Symbol.split, []],
]) {
	const argument = { [symbol]: 1 };
	check(
		name + " rejects a non-callable object symbol method",
		throwsTypeError(() => method.call("a1b1c", argument, ...args)),
	);
}

for (const [name, method, symbol, expected] of [
	["match", String.prototype.match, Symbol.match, "1"],
	["matchAll", String.prototype.matchAll, Symbol.matchAll, "1"],
	["search", String.prototype.search, Symbol.search, 1],
]) {
	for (const missing of [null, undefined]) {
		const argument = { [symbol]: missing, toString: () => "1" };
		const result = method.call("a1b1c", argument);
		const actual =
			name === "matchAll" ? [...result][0][0] : name === "match" ? result[0] : result;
		check(name + " falls back for a nullish object symbol method", actual === expected);
	}
}

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
