function iterable(results) {
	return {
		[Symbol.iterator]() {
			let index = 0;
			return { next: () => results[index++] ?? { done: true } };
		},
	};
}

const events = [];
const scenario = process.env.ITERATOR_RESULT_CASE;
if (scenario === "shapes") {
	const results = [
		{ value: 1, done: false },
		{ done: false, value: 2 },
		{ value: 3 },
		Object.assign(Object.create({ value: 4 }), { done: false }),
	];
	for (let round = 0; round < 50; round++)
		for (const value of iterable(results)) events.push(value);
} else if (scenario === "getters") {
	const prototype = {
		get value() {
			events.push("inherited");
			return 7;
		},
	};
	const changed = Object.assign(Object.create(prototype), { done: false });
	Object.defineProperty(changed, "value", { value: 3, configurable: true });
	Object.defineProperty(changed, "done", {
		get() {
			events.push("done");
			delete changed.value;
			const garbage = Array.from({ length: 100 }, (_, index) => ({ index }));
			events.push(garbage.length);
			return false;
		},
	});
	const finished = {
		done: true,
		get value() {
			throw new Error("unread");
		},
	};
	for (const value of iterable([changed, finished])) events.push(value);
} else if (scenario === "proxies") {
	const result = new Proxy(
		{ done: false, value: 9 },
		{
			get(target, key, receiver) {
				events.push(key);
				return Reflect.get(target, key, receiver);
			},
		},
	);
	for (const value of iterable([result])) events.push(value);
} else if (scenario === "abrupt") {
	for (const key of ["done", "value"]) {
		const marker = { key };
		const result = { done: false };
		Object.defineProperty(result, key, {
			get() {
				throw marker;
			},
		});
		try {
			for (const value of iterable([result])) events.push(value);
		} catch (error) {
			events.push(error === marker, key);
		}
	}
} else throw new Error(`unknown scenario ${scenario}`);
console.log(JSON.stringify(events));
