function numberSuffix(prefix, count) {
	let out = "";
	for (let index = 0; index < count; index++) out += prefix + index * 0.5;
	return out;
}

function numberPrefix(suffix, values) {
	const parts = [];
	for (const value of values) parts.push(value * 1 + suffix);
	return parts.join("|");
}

function flags(label, values) {
	const parts = [];
	for (const value of values) parts.push(label + (value > 1));
	return parts.join(",");
}

function nullish(label, values) {
	const parts = [];
	for (const value of values) parts.push(label + (value > 1 ? null : undefined));
	return parts.join(",");
}

console.log(numberSuffix("x", 6));
console.log(
	numberPrefix(":n", [0, -0, 1.5, -2, 1e21, 1e-7, 2 ** 53, NaN, Infinity, -Infinity]),
);
console.log(flags("b=", [0, 2, 1, 3]));
console.log(nullish("v=", [0, 2]));
console.log(numberSuffix("", 3).length);

function normalize(text) {
	const trimmed = text.trim();
	return trimmed + ":" + Math.abs(trimmed.length);
}

const conversions = [];
const customText = {
	trim() {
		conversions.push("trim");
		return {
			[Symbol.toPrimitive](hint) {
				conversions.push(hint);
				return "custom";
			},
			get length() {
				conversions.push("length");
				return {
					valueOf() {
						conversions.push("abs");
						return -6;
					},
				};
			},
		};
	},
};
console.log(normalize("  score  "));
console.log(normalize(customText), conversions.join(","));
for (const value of [17n, Symbol("suffix")]) {
	try {
		console.log(
			normalize({
				trim() {
					return value;
				},
			}),
		);
	} catch (error) {
		console.log(error.name);
	}
}
const failure = { marker: "coercion" };
try {
	normalize({
		trim() {
			return {
				[Symbol.toPrimitive]() {
					throw failure;
				},
			};
		},
	});
} catch (error) {
	console.log(error === failure);
}

function ordinaryKinds(input, flag) {
	const value = flag ? String(input) : Symbol("input");
	console.log(Number.isFinite(value), Number.isNaN(value));
	try {
		return Math.abs(value);
	} catch (error) {
		return error.name;
	}
}
console.log(ordinaryKinds(-7, true), ordinaryKinds(-7, false));
console.log(Math.abs.call(7, undefined), Math.abs.call("receiver", null));

function classify(input, flag) {
	const value = flag ? String(input) : Symbol("input");
	return [
		typeof value === "number",
		typeof value === "object",
		typeof value === "function",
		typeof value === "string",
		Number.isInteger(value),
	].join(",");
}
console.log(classify(7, true), classify(7, false));

const searchEffects = [];
function search(receiver, needle, position) {
	return String.prototype.includes.call(receiver, needle, position);
}
function converted(label, value) {
	return {
		[Symbol.toPrimitive](hint) {
			searchEffects.push(label + ":" + hint);
			return value;
		},
	};
}
console.log(
	search(
		converted("receiver", "abc"),
		converted("needle", "b"),
		converted("position", 1),
	),
	searchEffects.join(","),
);
searchEffects.length = 0;
try {
	search(
		converted("receiver", "abc"),
		converted("needle", Symbol("needle")),
		converted("position", 1),
	);
} catch (error) {
	console.log(error.name, searchEffects.join(","));
}

function truthyKinds(input, flag) {
	const value = flag
		? Symbol(String(input))
		: {
				valueOf() {
					throw new Error("Boolean coercion called user code");
				},
			};
	return value ? !value : true;
}
function nilKinds(flag) {
	const value = flag ? null : undefined;
	return value ? false : !value;
}
console.log(truthyKinds(7, true), truthyKinds(7, false), nilKinds(true), nilKinds(false));
