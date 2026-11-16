const OriginalArray = Array;
const originalFrom = Array.from;
const scenario = process.env.ARRAY_TRANSPORT_CASE ?? "retained";
const trace = [];
let held;

function copy(input) {
	return Array.from(input);
}
function observedCopy(input) {
	const result = Array.from(input);
	held = result;
	return [result[0], result.length, Boolean(result), held === result];
}
function mappedCopy(input, mapper) {
	const result = Array.from(input, mapper);
	held = result;
	return result;
}
function check(condition) {
	if (!condition) throw new Error("Array.from transport differs");
}
function replaceDuringArgument() {
	Array.from = () => 73;
	return [3, 7];
}
function argumentCopy() {
	return Array.from(replaceDuringArgument());
}

for (let index = 0; index < 8; index++) {
	check(copy([2, 4])[1] === 4);
	check(observedCopy([2, 4])[1] === 2);
	check(mappedCopy([2, 4], (value) => value + 1)[0] === 3);
}

let output;
if (scenario === "retained") {
	const source = [5, 9];
	const result = copy(source);
	check(result !== source && OriginalArray.isArray(result));
	output = [result, observedCopy(source), held !== source];
} else if (scenario.startsWith("method-")) {
	const shared = [13, 17];
	const value =
		scenario === "method-string"
			? "text"
			: scenario === "method-number"
				? 42
				: scenario === "method-object"
					? { 0: 11, length: 1 }
					: shared;
	const replacement = function () {
		trace.push(this === OriginalArray);
		return value;
	};
	if (scenario === "method-getter") {
		Object.defineProperty(OriginalArray, "from", {
			configurable: true,
			get() {
				trace.push("get");
				return replacement;
			},
		});
	} else {
		OriginalArray.from = replacement;
	}
	check(copy([1]) === value);
	output = [value, observedCopy([1]), held === value, trace];
} else if (scenario === "namespace") {
	function Replacement() {}
	Replacement.from = function () {
		trace.push(this === Replacement);
		return { 0: 19, length: 1 };
	};
	globalThis.Array = Replacement;
	output = [copy([1]), observedCopy([1]), trace];
} else if (scenario === "namespace-getter") {
	Object.defineProperty(globalThis, "Array", {
		configurable: true,
		get() {
			trace.push("namespace");
			return OriginalArray;
		},
	});
	output = [copy([3, 5]), trace];
} else if (scenario === "argument-replace") {
	output = [argumentCopy(), copy([1])];
} else if (scenario === "iterator-replace") {
	const source = {
		get [Symbol.iterator]() {
			trace.push("iterator");
			OriginalArray.from = () => "next";
			return function* () {
				yield 23;
				yield 29;
			};
		},
	};
	output = [copy(source), copy([1]), trace];
} else if (scenario === "mapper-replace") {
	output = [
		mappedCopy([2, 5], (value, index) => {
			trace.push(index);
			OriginalArray.from = () => "next";
			return value * 3;
		}),
		copy([1]),
		trace,
	];
} else if (scenario === "iterator-throw" || scenario === "mapper-throw") {
	const marker = { marker: "abrupt" };
	let caught = false;
	const previous = held;
	try {
		if (scenario === "iterator-throw") {
			copy({
				get [Symbol.iterator]() {
					throw marker;
				},
			});
		} else {
			mappedCopy(
				{
					*[Symbol.iterator]() {
						try {
							yield 1;
						} finally {
							trace.push("closed");
						}
					},
				},
				() => {
					throw marker;
				},
			);
		}
	} catch (error) {
		caught = error === marker;
	}
	check(caught && previous === held);
	output = [caught, held, trace];
} else if (scenario === "custom-constructor") {
	function Custom(length) {
		this.initialLength = length;
	}
	Custom.from = originalFrom;
	globalThis.Array = Custom;
	const result = copy({ 0: 31, length: 1 });
	check(result instanceof Custom && !OriginalArray.isArray(result));
	output = [result[0], result.length, result.initialLength];
} else if (scenario === "borrowed") {
	const borrowed = originalFrom;
	output = borrowed.call(undefined, [37, 41]);
} else {
	throw new Error("unknown transport scenario");
}
console.log(JSON.stringify(output));
