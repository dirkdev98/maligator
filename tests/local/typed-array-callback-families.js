"use strict";
const gc = globalThis.__mal_collect_garbage ?? globalThis.gc;
const rows = [];
const calls = [];
function scalar(value) {
	return typeof value === "bigint"
		? `${value}n`
		: typeof value === "number" && Number.isNaN(value)
			? "NaN"
			: Object.is(value, -0)
				? "-0"
				: value;
}
function result(value) {
	return ArrayBuffer.isView(value)
		? [value.constructor.name, Array.from(value, scalar)]
		: scalar(value);
}
function invoke(values, method, hook = () => {}) {
	let factor = 1;
	const context = { name: "context" };
	const callback = function typedElement(value, index, receiver, missing = 7) {
		let offset = index;
		for (let i = 0; i < 2; i++) offset += index;
		calls.push([
			scalar(value),
			index,
			receiver === values,
			arguments.length,
			arguments[1],
			missing,
			this === context,
			factor,
		]);
		hook(index, receiver);
		if (index === 1) gc?.();
		if (value === 91) throw new RangeError("element");
		factor += 0.5;
		return typeof value === "bigint" ? value : value * factor + offset;
	};
	switch (method) {
		case "map":
			return values.map(callback, context);
		case "filter":
			return values.filter(callback, context);
		case "forEach":
			return values.forEach(callback, context);
		case "some":
			return values.some(callback, context);
		case "every":
			return values.every(callback, context);
		case "find":
			return values.find(callback, context);
		case "findIndex":
			return values.findIndex(callback, context);
		case "findLast":
			return values.findLast(callback, context);
		case "findLastIndex":
			return values.findLastIndex(callback, context);
	}
}
function restMap(values) {
	return values.map(function typedRestElement(value, ...tail) {
		let index = tail[0];
		for (let i = 0; i < 2; i++) index += tail[0];
		return value + index + tail.length + tail[1].length;
	});
}
function capture(action) {
	calls.length = 0;
	try {
		rows.push([result(action()), calls.slice()]);
	} catch (error) {
		rows.push([
			error.name,
			error.message === "element" || error.message === "coercion"
				? error.message
				: "builtin",
			calls.slice(),
		]);
	}
}
const methods = [
	"map",
	"filter",
	"forEach",
	"some",
	"every",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
];
for (const Ctor of [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
]) {
	const bigint = Ctor === BigInt64Array || Ctor === BigUint64Array;
	for (const method of methods) {
		capture(() => invoke(new Ctor(bigint ? [0n, 2n, 3n] : [0, 2, 3]), method));
		capture(() => invoke(new Ctor(0), method));
	}
}
capture(() => restMap(new Float64Array([1, 2, 3])));
for (const method of methods) {
	capture(() =>
		invoke(new Float64Array([0, 0, 0]), method, (index, values) => {
			if (index === 0) values[1] = 8;
			if (index === 2) values[1] = 9;
		}),
	);
	capture(() => invoke(new Float64Array([0, 91, 0]), method));
	capture(() =>
		invoke(new Float64Array([0, 2, 3]), method, (index, values) => {
			if ((index === 0 || index === 2) && values.buffer.byteLength > 0)
				values.buffer.transfer();
		}),
	);
	capture(() => {
		const buffer = new ArrayBuffer(24, { maxByteLength: 40 });
		const values = new Float64Array(buffer);
		values.set([0, 2, 3]);
		return invoke(values, method, (index) => {
			if (index === 0) buffer.resize(8);
			if (index === 1) {
				buffer.resize(32);
				values[2] = 7;
				values[3] = 99;
			}
		});
	});
	capture(() => {
		const values = new Int32Array(new SharedArrayBuffer(12));
		return invoke(values, method, (index) => {
			if (index === 0) values[1] = 7;
		});
	});
}
const speciesOrder = [];
for (const method of ["map", "filter"]) {
	const values = new Int32Array([1, 2, 3]);
	Object.defineProperty(values, "constructor", {
		value: {
			get [Symbol.species]() {
				speciesOrder.push(`${method}:species`);
				values[0] = 4;
				return function (length) {
					speciesOrder.push(length);
					return new Float64Array(length);
				};
			},
		},
	});
	capture(() =>
		invoke(values, method, (index) => speciesOrder.push(`${method}:${index}`)),
	);
	const invalid = new Int32Array([1, 2]);
	Object.defineProperty(invalid, "constructor", {
		value: {
			[Symbol.species]: function () {
				return {};
			},
		},
	});
	capture(() => invoke(invalid, method));
}
rows.push(speciesOrder);
for (const method of methods) {
	const changed = new Float64Array([1, 2]);
	Object.defineProperty(changed, method, {
		value: function (callback, context) {
			return callback.call(context, 5, "key", this, 23);
		},
	});
	capture(() => invoke(changed, method));
}
capture(() =>
	invoke(
		new Map([
			["key", 2],
			["next", 3],
		]),
		"forEach",
	),
);
capture(() => invoke(new Set([2, 3]), "forEach"));
const fresh = [1, , 3];
Object.defineProperty(fresh, "map", {
	value: function (callback) {
		return callback("value", "key", this, "extra");
	},
});
capture(() =>
	fresh.map(function (...args) {
		calls.push(args);
		return args.length;
	}),
);
capture(() =>
	invoke(new Float64Array([1, 2, 3]), "map", (index) => {
		if (index === 1) rows.push(result(restMap(new Float64Array([7, 8]))));
	}),
);
const escaped = [];
const saved = new Float64Array([2, 4]).map(function escapedElement(value, index) {
	escaped.push(arguments);
	arguments[0] = value + 10;
	gc?.();
	return value + index;
});
rows.push(
	result(saved),
	escaped[0] === escaped[1],
	escaped.map((args) => [args.length, args[0], args[1], args[2] === escaped[0][2]]),
);
const coercions = [];
const coercing = new Int32Array([1, 2, 3]);
capture(() =>
	coercing.map(function coercingElement(value, index) {
		return {
			valueOf() {
				coercions.push([value, index]);
				if (index === 0) coercing[1] = 9;
				if (index === 1) throw new SyntaxError("coercion");
				return value;
			},
		};
	}),
);
rows.push(coercions);
console.log(JSON.stringify(rows));
