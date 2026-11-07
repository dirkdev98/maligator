const scenarios = {
	ordinary() {
		const target = { first: 1 };
		const returned = Object.assign(target, { revision: 17, active: true, label: "item" });
		return [returned === target, target];
	},
	setters() {
		const events = [];
		const target = Object.create({
			set first(value) {
				events.push(["set:first", value]);
			},
			set second(value) {
				events.push(["set:second", value]);
			},
		});
		Object.assign(target, {
			first: (events.push("value:first"), 11),
			second: (events.push("value:second"), 22),
		});
		return events;
	},
	throw() {
		const events = [];
		const target = Object.create({
			set first(value) {
				this.saved = value;
				events.push("first");
			},
			set second(_value) {
				events.push("second");
				throw "stopped";
			},
			set third(_value) {
				events.push("third");
			},
		});
		let error;
		try {
			Object.assign(target, { first: 11, second: 22, third: 33 });
		} catch (value) {
			error = value;
		}
		return [error, events, target.saved];
	},
	frozen() {
		const target = Object.freeze({ first: 1 });
		let error;
		try {
			Object.assign(target, { first: 2 });
		} catch (value) {
			error = value.name;
		}
		return [error, target.first];
	},
	proxy() {
		const events = [],
			object = {};
		const target = new Proxy(object, {
			set(receiver, key, value) {
				events.push([key, value]);
				return Reflect.set(receiver, key, value);
			},
		});
		const returned = Object.assign(target, { first: 11, second: false });
		return [returned === target, events, object];
	},
	refused() {
		const target = new Proxy(
			{},
			{
				set() {
					return false;
				},
			},
		);
		try {
			Object.assign(target, { first: 11 });
		} catch (error) {
			return error.name;
		}
	},
	primitive() {
		const target = Object.assign(3, { revision: 7 });
		return [typeof target, Number(target), target.revision];
	},
	accessors() {
		const events = [];
		const target = Object.assign(
			{},
			{
				get first() {
					events.push("first");
					return 11;
				},
				get second() {
					events.push("second");
					return 22;
				},
			},
		);
		return [events, target];
	},
	escaped() {
		const source = { first: 11, second: 22 };
		globalThis.assignSource = source;
		const target = Object.create({
			set first(_value) {
				globalThis.assignSource.second = 41;
			},
		});
		Object.assign(target, source);
		return target.second;
	},
	objects() {
		const first = { token: 7 },
			second = { token: 9 };
		const target = Object.assign({}, { first, second });
		return [
			target.first === first,
			target.second === second,
			target.first.token + target.second.token,
		];
	},
	specialValues() {
		const target = Object.assign(
			{},
			{
				negative: -0,
				nan: NaN,
				infinite: Infinity,
				empty: null,
				absent: undefined,
				large: 12345678901234567890n,
			},
		);
		return [
			Object.is(target.negative, -0),
			Number.isNaN(target.nan),
			String(target.infinite),
			target.empty,
			Object.hasOwn(target, "absent"),
			String(target.large),
		];
	},
	keys() {
		const symbol = Symbol("key"),
			target = {};
		Object.assign(target, { 2: 22, 1: 11, name: 3, [symbol]: 4 });
		return [Object.keys(target), target[symbol]];
	},
	prototype() {
		const prototype = { inherited: 7 },
			target = {};
		Object.assign(target, { ["__proto__"]: prototype });
		return [
			Object.getPrototypeOf(target) === prototype,
			target.inherited,
			Object.hasOwn(target, "__proto__"),
		];
	},
	plainSources() {
		const first = { a: 1, b: 2 };
		const target = Object.assign({}, first, { b: 3, c: 4 }, null, { toString: 5 });
		first.a = 9;
		return [
			Object.keys(target),
			target.a,
			target.b,
			target.c,
			Object.hasOwn(target, "toString"),
		];
	},
	hiddenTarget() {
		const target = {};
		Object.defineProperty(target, "hidden", {
			value: 1,
			writable: true,
			enumerable: false,
			configurable: true,
		});
		Object.assign(target, { hidden: 2, shown: 3 });
		return [Object.keys(target), target.hidden];
	},
	sharedPrototype() {
		const base = { kept: 1 };
		const child = Object.create(base);
		const before = child.added;
		Object.assign(base, { added: 2 });
		return [before, child.added, child.kept];
	},
	mutable() {
		Object.assign = (target, source) => [target.original, source.revision, "custom"];
		return Object.assign({ original: 3 }, { revision: 11 });
	},
};
console.log(JSON.stringify(scenarios[process.env.LITERAL_ASSIGN_CASE || "ordinary"]()));
