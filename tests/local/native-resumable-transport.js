const events = [];
function collect() {
	globalThis.__mal_collect_garbage?.();
}
function transform(value, index) {
	let total = value + index;
	for (let i = 0; i < 2; i++) total += value;
	collect();
	if (value === 101) throw new RangeError("transport");
	return total;
}
transform(1, 2);
function* generator(values, payload) {
	const callback = function callback(value, index) {
		return transform(value, index);
	};
	callback(1, 2);
	const before = transform(+payload.value, 0);
	yield { before, payload };
	collect();
	try {
		return [values.map(callback), transform(+before, 1), payload.value];
	} catch (error) {
		return [error.name, payload.value];
	}
}
async function asynchronous(values, payload) {
	const callback = function callback(value, index) {
		return transform(value, index);
	};
	callback(1, 2);
	const before = transform(+payload.value, 0);
	await Promise.resolve(before);
	collect();
	try {
		return [values.map(callback), transform(+before, 1), payload.value];
	} catch (error) {
		return [error.name, payload.value];
	}
}
const payload = { value: 3 };
for (const values of [[2, 4], ["2", 4], [101]]) {
	const iterator = generator(values, payload);
	const first = iterator.next();
	collect();
	events.push([
		first.value.before,
		first.value.payload === payload,
		iterator.next().value,
	]);
}
const accessor = [2, 4];
Object.defineProperty(accessor, 0, {
	get() {
		collect();
		return {
			valueOf() {
				collect();
				return 5;
			},
		};
	},
});
const overridden = [2];
overridden.map = function (callback) {
	return [callback("override", 0, this)];
};
(async function main() {
	for (const values of [[2, 4], ["2", 4], [101], accessor, overridden]) {
		events.push(await asynchronous(values, payload));
		collect();
	}
	console.log(JSON.stringify(events));
})().catch((error) => {
	console.error(error.stack);
	process.exitCode = 1;
});
