const observations = [];
function collect() {
	globalThis.__mal_collect_garbage?.();
}

function reduce(values, initial, right = false) {
	let factor = 2;
	const callback = function numericReducer(acc, value, index, receiver) {
		collect();
		observations.push([
			acc,
			typeof value === "bigint" ? "bigint" : value,
			index,
			receiver === values,
			factor,
		]);
		if (value === 101) throw new RangeError("reduction");
		if (value === 17) {
			factor = 3;
			receiver[2] = 9;
			receiver.push(1000);
			observations.push(reduce([2, 3], 4));
		}
		for (let i = 0; i < 2; i++) acc += value * factor;
		return +acc;
	};
	return right ? values.reduceRight(callback, initial) : values.reduce(callback, initial);
}

for (const right of [false, true]) {
	observations.push(reduce([1, 2, 3], 0, right));
	observations.push(reduce([1, "2", 3], "5", right));
	observations.push(reduce([1, , 3], 0, right));
	observations.push(reduce([17, 2, 3], 0, right));
	const values = [1, 2, 3];
	Object.defineProperty(values, 1, {
		get() {
			collect();
			observations.push("get");
			return {
				valueOf() {
					collect();
					observations.push("coerce");
					return 4;
				},
			};
		},
	});
	observations.push(reduce(values, 0, right));
	for (const value of [101, Symbol("bad"), 1n]) {
		try {
			reduce([value, value, value], 0, right);
		} catch (error) {
			observations.push(error.name);
		}
	}
	observations.push(reduce([3, 4], 0, right));
}

function special(values, initial) {
	return values.reduce(function identity(acc, value) {
		for (let i = 0; i < 2; i++) acc *= value;
		return acc;
	}, initial);
}
for (const initial of [-0, NaN, Infinity, -Infinity]) {
	const value = special([1, 1], initial);
	observations.push(Object.is(value, -0) ? "-0" : String(value));
}
observations.push(Object.is(special([], -0), -0));

function unseeded(values) {
	return values.reduce(function unseededReducer(acc, value) {
		for (let i = 0; i < 2; i++) acc += value;
		return acc;
	});
}
observations.push(unseeded([, 3, 4]));
try {
	unseeded(new Array(3));
} catch (error) {
	observations.push(error.name);
}

const throwing = [1, 2, 3];
Object.defineProperty(throwing, 1, {
	get() {
		observations.push("throwing getter");
		throw new RangeError("get");
	},
});
try {
	reduce(throwing, 0);
} catch (error) {
	observations.push(error.name);
}

const overridden = [1, 2];
overridden.reduce = function (callback, initial) {
	return callback(initial, "5", 8, this);
};
observations.push(reduce(overridden, 0));
console.log(JSON.stringify(observations));
