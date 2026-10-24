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
