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
} else if (scenario === "protocols") {
	function* generate() {
		yield { kind: "generator" };
		return 17;
	}
	for (const override of [false, true]) {
		const sources = [
			generate(),
			Iterator.from([2, 3]).map((value) => ({ mapped: value * 2 })),
			"a1b2".matchAll(/\d/g),
		];
		for (const source of sources) {
			if (override) {
				const next = source.next;
				source.next = function () {
					events.push("override", this === source, arguments.length);
					return Reflect.apply(next, this, []);
				};
			}
			for (const value of source) events.push(value);
		}
	}
} else if (scenario === "calls") {
	function consume(iterator) {
		const values = [];
		for (const value of { [Symbol.iterator]: () => iterator }) values.push(value);
		events.push(values);
	}
	function make(seed) {
		let index = 0;
		const iterator = {
			next() {
				events.push("compiled", this === iterator, arguments.length);
				iterator.next = () => {
					throw new Error("next was read twice");
				};
				return index < 3 ? { value: seed + index++, done: false } : { done: true };
			},
		};
		return iterator;
	}
	consume(make(5));
	consume(make(10));
	const owner = { marker: "owner", index: 0 };
	function boundNext(prefix) {
		events.push("bound", this.marker, prefix, arguments.length);
		return this.index < 2 ? { value: this.index++, done: false } : { done: true };
	}
	consume({ next: boundNext.bind(owner, 9) });
	const proxied = { index: 0 };
	proxied.next = new Proxy(
		function () {
			events.push("target", this === proxied, arguments.length);
			const padding = Array.from({ length: 32 }, () => ({ owner: this }));
			return this.index < 2
				? { value: this.index++ + padding.length, done: false }
				: { done: true };
		},
		{
			apply(target, receiver, args) {
				events.push("proxy", receiver === proxied, args.length);
				return Reflect.apply(target, receiver, args);
			},
		},
	);
	consume(proxied);
	const native = [{ score: 3 }, undefined, 7].values();
	consume({ next: native.next.bind(native) });
	let entered = false;
	const outer = make(20);
	const original = outer.next;
	outer.next = function () {
		if (!entered) {
			entered = true;
			consume(make(30));
		}
		return Reflect.apply(original, this, []);
	};
	Object.defineProperty(outer.next, "call", {
		value() {
			throw new Error("call property was read");
		},
	});
	consume(outer);
	for (const next of [() => 1, class {}]) {
		try {
			consume({ next });
		} catch (error) {
			events.push(error.name);
		}
	}
	const marker = {};
	try {
		consume({
			next() {
				throw marker;
			},
		});
	} catch (error) {
		events.push(error === marker);
	}
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
