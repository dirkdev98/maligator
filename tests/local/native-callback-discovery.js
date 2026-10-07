const events = [];
function collect() {
	globalThis.__mal_collect_garbage?.();
}
function mapValues(values, payload) {
	return values.map(function mapper(value, index, receiver) {
		let offset = index * 3;
		for (let i = 0; i < 2; i++) offset += index;
		collect();
		if (value === "throw" || value === 101) throw new RangeError("mapper");
		return [value + offset, receiver === values, payload.label];
	});
}
function reduceValues(values, initial) {
	return values.reduce(function reducer(accumulator, value, index, receiver) {
		collect();
		if (index === 1)
			return {
				valueOf() {
					collect();
					return accumulator + value;
				},
			};
		return accumulator + value + index + receiver.length;
	}, initial);
}
function numericReduce(values, initial) {
	return values.reduce(function numericReducer(accumulator, value, index, receiver) {
		collect();
		if (index === 1)
			return {
				valueOf() {
					collect();
					return 7;
				},
			};
		return accumulator + value + index + receiver.length;
	}, initial);
}
const payload = { label: "capture" };
const coerced = {
	valueOf() {
		collect();
		events.push("coerce");
		return 7;
	},
};
events.push(mapValues([2, "4", coerced], payload));
const holes = [, 8];
Object.defineProperty(holes, 0, {
	get() {
		collect();
		events.push("get");
		return 5;
	},
});
events.push(mapValues(holes, payload));
events.push(reduceValues([2, 3, 4], 1));
events.push(reduceValues(["2", 3, 4], "initial"));
events.push(numericReduce([2, 3, 4], 1));
events.push(numericReduce(["2", 3, 4], "initial"));
const overridden = [];
overridden.map = function (callback) {
	collect();
	return [callback("override", "5", this)];
};
events.push(mapValues(overridden, payload));
try {
	mapValues([2, "throw", 4], payload);
} catch (error) {
	events.push(error.name);
}
try {
	mapValues([2, 101], payload);
} catch (error) {
	events.push(error.name);
}
try {
	mapValues([1n], payload);
} catch (error) {
	events.push(error.name);
}
events.push(mapValues([3], payload));
console.log(JSON.stringify(events));
