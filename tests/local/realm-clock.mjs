const mode = process.env.REALM_CLOCK_CASE ?? "intact";
const savedDate = Date;
const savedNow = Date.now;
const events = [];
function clock() {
	return Date.now();
}
function twice() {
	Date.now();
	return [Date.now(), Date.now()];
}
function ignored(prepare) {
	return Date.now(prepare());
}
function ignoredValue(value) {
	return Date.now(value);
}
function shadow(Date) {
	return Date.now();
}
function valid(value) {
	return (
		typeof value === "number" &&
		value % 1 === 0 &&
		value >= 1577836800000 &&
		value < 4102444800000
	);
}
globalThis.clockConsumers = { clock, twice, ignored, ignoredValue };
let result;
if (mode === "intact") {
	result = [valid(clock()), twice().every(valid)];
} else if (mode === "ignored-value") {
	result = valid(
		ignoredValue({
			[Symbol.toPrimitive]() {
				throw new Error("unexpected clock argument coercion");
			},
		}),
	);
} else if (mode === "method") {
	const before = valid(clock());
	Date.now = () => {
		events.push("method");
		return 17;
	};
	result = [before, clock(), twice(), events];
} else if (mode === "global") {
	const before = valid(clock());
	globalThis.Date = {
		now() {
			events.push("global");
			return 19;
		},
	};
	result = [before, clock(), events];
} else if (mode === "accessor") {
	const before = valid(clock());
	Object.defineProperty(Date, "now", {
		configurable: true,
		get() {
			events.push("get");
			return () => {
				events.push("call");
				return 23;
			};
		},
	});
	result = [before, clock(), events];
} else if (mode === "captured") {
	result = [
		valid(
			ignored(() => {
				events.push("argument");
				Date.now = () => 29;
			}),
		),
		clock(),
		events,
	];
} else if (mode === "argument-throw") {
	const thrown = { label: "clock argument" };
	Date.now = () => {
		events.push("called");
		return 31;
	};
	try {
		ignored(() => {
			events.push("argument");
			throw thrown;
		});
	} catch (error) {
		result = [error === thrown, events];
	}
} else if (mode === "shadow") {
	result = shadow({ now: () => 37 });
} else if (mode === "lexical") {
	const Date = { now: () => 41 };
	result = Date.now();
}
globalThis.Date = savedDate;
Object.defineProperty(Date, "now", {
	value: savedNow,
	writable: true,
	configurable: true,
});
console.log(JSON.stringify(result));
