"use strict";

const gc = globalThis.__mal_collect_garbage;
const observations = [];
function collect() {
	gc?.();
}

function reduce(values, initial, right = false, action = "") {
	let factor = 2;
	let calls = 0;
	const callback = function typedReducer(acc, value, index, receiver, missing = 7) {
		collect();
		observations.push([
			arguments.length,
			arguments[0],
			index,
			receiver === values,
			value,
			missing,
			this === undefined,
		]);
		if (calls++ === 0) {
			factor = 3;
			if (action === "mutate") {
				receiver[right ? 1 : 2] = 17;
				observations.push(reduce(new Int16Array([2, 3]), 4));
			} else if (action === "detach") {
				receiver.buffer.transfer();
			} else if (action === "shrink" || action === "regrow") {
				receiver.buffer.resize(0);
			} else if (action === "grow") {
				receiver.buffer.resize(48);
			}
		} else if (calls === 2 && action === "regrow") {
			receiver.buffer.resize(32);
			receiver[right ? 1 : 2] = 19;
		}
		if (value === 101) throw new RangeError("typed callback");
		for (let i = 0; i < 2; i++) acc += (value === undefined ? -20 : value) * factor;
		observations.push([acc, arguments[0], factor]);
		return +acc + index + arguments.length;
	};
	return right ? values.reduceRight(callback, initial) : values.reduce(callback, initial);
}

function restReduce(values, initial, right = false) {
	const callback = function typedRestReducer(acc, value, ...tail) {
		collect();
		observations.push([tail.length, tail[0], tail[1] === values]);
		for (let i = 0; i < 2; i++) acc += value;
		return +acc;
	};
	return right ? values.reduceRight(callback, initial) : values.reduce(callback, initial);
}

function unseeded(values, right = false) {
	const callback = function typedUnseededReducer(acc, value, index) {
		collect();
		observations.push(index);
		for (let i = 0; i < 2; i++) acc += value;
		return acc;
	};
	return right ? values.reduceRight(callback) : values.reduce(callback);
}

function snapshotReduce(values) {
	return values.reduce(function typedSnapshotReducer(
		acc,
		value,
		index,
		receiver,
		missing = 7,
	) {
		collect();
		observations.push([arguments.length, arguments[0], receiver === values, missing]);
		for (let i = 0; i < 2; i++) acc += value;
		return +acc + index + arguments.length;
	}, 0);
}

globalThis.__mal_snapshot_reduce = snapshotReduce;
observations.push(snapshotReduce(new Float64Array([1, 2, 3])));

for (const right of [false, true]) {
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
	]) {
		observations.push(Ctor.name, reduce(new Ctor([1, 2, 3, 4]), 0, right, "mutate"));
		observations.push(restReduce(new Ctor([1, 2, 3]), 0, right));
		observations.push(unseeded(new Ctor([2, 3, 4]), right));
		observations.push(
			reduce(new Ctor(0), -0, right),
			Object.is(unseeded(new Ctor([-0]), right), -0),
		);
		try {
			unseeded(new Ctor(0), right);
		} catch (error) {
			observations.push(error.name);
		}
	}
	for (const action of ["detach", "shrink", "grow", "regrow"]) {
		const buffer = new ArrayBuffer(32, { maxByteLength: 48 });
		const values = new Float64Array(buffer);
		values.set([1, 2, 3, 4]);
		observations.push(action, reduce(values, 0, right, action));
	}
	const fixedBuffer = new ArrayBuffer(40, { maxByteLength: 48 });
	const fixed = new Float64Array(fixedBuffer, 8, 4);
	fixed.set([2, 3, 4, 5]);
	observations.push(reduce(fixed, 0, right, "regrow"));
	const shared = new Float64Array(new SharedArrayBuffer(32));
	shared.set([2, 3, 4, 5]);
	observations.push(reduce(shared, 0, right, "mutate"));
	class Numbers extends Float64Array {}
	observations.push(reduce(new Numbers([2, 3, 4]), 0, right));
	const initial = {
		valueOf() {
			collect();
			observations.push("coerce initial");
			return 5;
		},
	};
	observations.push(reduce(new Float64Array([2, 3, 4]), initial, right));
	try {
		reduce(new Int32Array([2, 101, 4]), 0, right);
	} catch (error) {
		observations.push(error.name);
	}
	observations.push(reduce(new Int32Array([2, 3]), 0, right));
	for (const Ctor of [BigInt64Array, BigUint64Array]) {
		observations.push(String(unseeded(new Ctor([2n, 3n, 4n]), right)));
		try {
			reduce(new Ctor([2n, 3n]), 0, right);
		} catch (error) {
			observations.push(error.name);
		}
	}
	const changed = new Int32Array([2, 3]);
	const replacement = function (callback, initial) {
		return callback(initial, "5", 9, this, 23);
	};
	Object.defineProperties(changed, {
		reduce: { value: replacement },
		reduceRight: { value: replacement },
	});
	observations.push(reduce(changed, 0, right), restReduce(changed, 0, right));
	const wrongFamily = new Int32Array([2, 3]);
	Object.defineProperties(wrongFamily, {
		reduce: { value: Array.prototype.map },
		reduceRight: { value: Array.prototype.map },
	});
	observations.push(restReduce(wrongFamily, 0, right));
	const fake = {
		reduce: Int32Array.prototype.reduce,
		reduceRight: Int32Array.prototype.reduceRight,
	};
	try {
		reduce(fake, 0, right);
	} catch (error) {
		observations.push(error.name);
	}
	const proxy = new Proxy(new Int32Array([2]), {});
	try {
		reduce(proxy, 0, right);
	} catch (error) {
		observations.push(error.name);
	}
	const detached = new Int32Array([2]);
	detached.buffer.transfer();
	try {
		reduce(detached, 0, right);
	} catch (error) {
		observations.push(error.name);
	}
}

for (const initial of [-0, NaN, Infinity, -Infinity]) {
	const result = restReduce(new Float64Array([0, -0]), initial);
	observations.push(Object.is(result, -0) ? "-0" : String(result));
}
observations.push(restReduce(new Float64Array([NaN, Infinity, -Infinity]), 0));

console.log(
	JSON.stringify(observations, (_key, value) =>
		typeof value === "bigint" ? `${value}n` : value,
	),
);
