const observations = [];
function collect() {
	globalThis.__mal_collect_garbage?.();
}

function runNumeric(values) {
	const transform = function transform(value, index) {
		let total = value + index;
		for (let i = 0; i < 2; i++) total += value;
		return total;
	};
	const calibration = transform(1, 2);
	return [calibration, values.map(transform)];
}

function runCaptured(values, offset) {
	const transform = function captured(value, index) {
		let total = value + index + offset;
		for (let i = 0; i < 2; i++) total += value;
		collect();
		if (index === 0) [4, 5].some((inner) => inner === 5);
		return { total, index };
	};
	transform(1, 2);
	return values.map(transform);
}

function runSnapshots(values) {
	const transform = function snapshots(value, index) {
		let total = value + index;
		for (let i = 0; i < 2; i++) total += value;
		collect();
		return [total, arguments.length, arguments[2].length];
	};
	transform(1, 2, []);
	return values.map(transform);
}

function runReceiver(values) {
	const transform = function receiver(value, index) {
		let total = value + index;
		for (let i = 0; i < 2; i++) total += value;
		return total + (this?.offset ?? 0);
	};
	transform(1, 2);
	return values.map(transform, { offset: 10 });
}

function runReduce(values) {
	const transform = function reducer(accumulator, value, index) {
		let total = accumulator + value + index;
		for (let i = 0; i < 2; i++) total += value;
		collect();
		return total + arguments.length + arguments[3].length;
	};
	transform(1, 2, 0, []);
	return values.reduce(transform, 0);
}

function runSigned(values) {
	const transform = function signed(value, index) {
		for (let i = 0; i < 2; i++) collect();
		return index === 0 ? -value : value;
	};
	transform(1, 2);
	return values
		.map(transform)
		.map((value) => (Object.is(value, -0) ? "-0" : String(value)));
}

observations.push(
	runNumeric([
		1,
		2.5,
		"7",
		true,
		null,
		undefined,
		{
			valueOf() {
				collect();
				observations.push("coercion");
				return 9;
			},
		},
	]),
);
observations.push(runSnapshots([2, 4]));
observations.push(runReceiver([2, 4]));
observations.push(runReduce([2, 4]));
observations.push(runSigned([0, -0, NaN, Infinity, -Infinity]));

const accessorValues = [1, 2];
Object.defineProperty(accessorValues, 0, {
	get() {
		collect();
		return {
			valueOf() {
				collect();
				return 3;
			},
		};
	},
});
observations.push(runCaptured(accessorValues, 10));

const overridden = [1];
overridden.map = function (callback) {
	return [callback("override", 0, this)];
};
observations.push(runNumeric(overridden));

for (const value of [Symbol("bad"), 1n]) {
	try {
		runNumeric([value]);
	} catch (error) {
		observations.push(error.name);
	}
}
observations.push(runNumeric([3, 4]));
console.log(JSON.stringify(observations));
