const scenario = process.env.MAPPED_CLOSURE_CASE;
const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const rows = [];

function describe(value) {
	if (Object.is(value, -0)) return "-0";
	if (Number.isNaN(value)) return "NaN";
	return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
}

function exercise(seed) {
	let shared = seed;
	const callbacks = Array.from(
		{ length: 16 },
		(_, bias) => (value) => value * 3 + bias + shared,
	);
	if (scenario === "instances") {
		for (let index = 0; index < 48; index++) {
			shared = seed + index;
			rows.push(callbacks[index & 15](index));
		}
	} else if (scenario === "argumentGc") {
		const index = seed & 15;
		rows.push(
			callbacks[index](
				(() => {
					callbacks.length = 0;
					collect();
					return 7;
				})(),
			),
		);
	} else if (scenario === "replacement") {
		callbacks[2] = (value) => ({ value: String(value), seed });
		rows.push(callbacks[2](7));
		callbacks[3] = function (value) {
			return this.prefix + value;
		}.bind({ prefix: "bound:" });
		rows.push(callbacks[3](8));
		callbacks[4] = new Proxy((value) => value, {
			apply(target, receiver, arguments_) {
				return "proxy:" + Reflect.apply(target, receiver, arguments_);
			},
		});
		rows.push(callbacks[4](9));
	} else if (scenario === "accessor") {
		const events = [];
		Object.defineProperty(callbacks, 2, {
			get() {
				events.push("get");
				collect();
				return (value) => "accessor:" + value;
			},
		});
		rows.push(callbacks[2]((events.push("argument"), 11)), events);
	} else if (scenario === "missing") {
		const events = [];
		for (const value of [undefined, null, 1, {}]) {
			callbacks[2] = value;
			try {
				callbacks[2](events.push("argument"));
			} catch (error) {
				events.push(error.name);
			}
		}
		delete callbacks[3];
		try {
			callbacks[3](events.push("missing argument"));
		} catch (error) {
			events.push(error.name);
		}
		rows.push(events);
	} else if (scenario === "coercion") {
		const events = [];
		rows.push(
			callbacks[2]({
				valueOf() {
					events.push("value");
					shared = 17;
					collect();
					return 5;
				},
			}),
		);
		shared = {
			valueOf() {
				events.push("shared");
				collect();
				return 23;
			},
		};
		rows.push(callbacks[3](7), events);
	} else if (scenario === "bigint") {
		const events = [];
		try {
			callbacks[2](3n);
		} catch (error) {
			events.push(error.name);
		}
		shared = 4n;
		try {
			callbacks[3](7);
		} catch (error) {
			events.push(error.name);
		}
		rows.push(events);
	} else if (scenario === "throwing") {
		const events = [];
		try {
			callbacks[2]({
				valueOf() {
					events.push("coerce");
					collect();
					throw new Error("fictional failure");
				},
			});
		} catch (error) {
			events.push(error.message);
		}
		rows.push(events);
	}
	collect();
}

function numeric() {
	let divisor = 1;
	const callbacks = Array.from(
		{ length: 16 },
		(_, bias) => (value) => (value * (bias + 1)) / divisor,
	);
	for (const value of [-0, 0, NaN, Infinity, -Infinity, 0.5, -13.25]) {
		rows.push(describe(callbacks[0](value)), describe(callbacks[3](value)));
		divisor = -divisor;
		collect();
	}
}

function tdz() {
	const events = [];
	const callbacks = Array.from(
		{ length: 16 },
		(_, bias) => (value) => value + bias + shared,
	);
	try {
		callbacks[2]({
			valueOf() {
				events.push("value");
				collect();
				return 3;
			},
		});
	} catch (error) {
		events.push(error.name);
	}
	let shared = 17;
	rows.push(callbacks[3](5), events);
}

if (scenario === "numbers") numeric();
else if (scenario === "tdz") tdz();
else if (scenario === "mutable") {
	const original = Array.from;
	let calls = 0;
	Array.from = function () {
		calls++;
		return [(value) => "custom:" + value];
	};
	try {
		const callbacks = Array.from({ length: 16 }, (_, bias) => (value) => value + bias);
		rows.push(callbacks[0](7), calls);
	} finally {
		Array.from = original;
	}
} else {
	exercise(3);
	exercise(29);
}
console.log(JSON.stringify(rows));
