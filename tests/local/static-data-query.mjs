function includes(value, from) {
	return [
		"foo",
		"bar",
		null,
		undefined,
		false,
		true,
		NaN,
		-0,
		2.5,
		5n,
		,
		12,
		13,
		14,
		15,
		16,
		17,
		18,
	].includes(value, from);
}
function own(key) {
	return { 0: 1, a: [1, { b: false }], undefined: 2 }.hasOwnProperty(key);
}
for (const value of ["foo", "missing", undefined, NaN, 0, 5n, {}, Symbol()]) {
	for (const from of [undefined, -Infinity, Infinity, -4, -0, 2.9, "1", null])
		console.log(includes(value, from));
}
for (const key of [0, -0, 0n, "0", "a", undefined, null, Symbol(), "toString"])
	console.log(own(key));
let conversions = 0;
console.log(
	own({
		[Symbol.toPrimitive](hint) {
			conversions++;
			console.log(hint);
			return "a";
		},
	}),
	conversions,
);
console.log(
	includes(18, {
		valueOf() {
			conversions++;
			return -1;
		},
	}),
	conversions,
);
for (const from of [
	1n,
	Symbol(),
	{
		valueOf() {
			throw new Error("coercion");
		},
	},
]) {
	try {
		includes("foo", from);
	} catch (error) {
		console.log(error.name);
	}
}
let empty = 0;
console.log(
	[].includes(1, {
		valueOf() {
			empty++;
			throw new Error("empty");
		},
	}),
	empty,
);
console.log(
	{}.hasOwnProperty({
		toString() {
			empty++;
			return "x";
		},
	}),
	empty,
);
let effects = 0;
function produce() {
	effects++;
	return 1;
}
console.log({ a: produce() }.hasOwnProperty("a"), effects);
console.log(
	Object.hasOwn(
		{ a: 1 },
		{
			toString() {
				effects++;
				return "a";
			},
		},
	),
	effects,
);

function observingKey() {
	const object = { a: 1 };
	const read = () => object;
	const key = {
		toString() {
			delete read().a;
			return "a";
		},
	};
	return object.hasOwnProperty(key);
}
function observingFrom() {
	const values = ["foo", "bar"];
	const read = () => values;
	return values.includes("new", {
		valueOf() {
			read()[0] = "new";
			return 0;
		},
	});
}
console.log(observingKey(), observingFrom());
