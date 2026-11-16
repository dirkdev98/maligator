const mode = process.env.REALM_UTC_CASE ?? "intact";
const savedDate = Date;
const savedUtc = Date.UTC;
const events = [];
function utc(year, month) {
	const numericYear = +year;
	const numericMonth = +month;
	return Date.UTC(numericYear, numericMonth, 1, 0, 0, 0, 0);
}
function extra(year, ignored) {
	const numericYear = +year;
	return Date.UTC(numericYear, 0, 1, 0, 0, 0, 0, ignored);
}
function empty() {
	return Date.UTC();
}
function one(year) {
	const number = +year;
	return Date.UTC(number);
}
function captured(prepare) {
	return Date.UTC(2024, 0, 1, 0, 0, 0, prepare());
}
function capturedExtra(prepare) {
	return Date.UTC(2024, 0, 1, 0, 0, 0, 0, prepare());
}
function unknown(year) {
	return Date.UTC(year, 0);
}
function shadow(Date) {
	return Date.UTC(2024, 0);
}
function scalar(value) {
	return Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : value;
}
globalThis.utcConsumers = {
	utc,
	extra,
	empty,
	one,
	captured,
	capturedExtra,
	unknown,
	shadow,
};
let result;
if (mode === "intact") {
	result = [
		utc(2024, 0),
		utc(0, -0),
		utc(99, 13),
		utc(-1, 0),
		scalar(empty()),
		one(2024),
		one(-0),
	];
} else if (mode === "nonfinite") {
	result = [scalar(utc(NaN, 0)), scalar(utc(Infinity, 0)), scalar(utc(2024, -Infinity))];
} else if (mode === "ignored") {
	result = extra(2024, {
		[Symbol.toPrimitive]() {
			throw new Error("ignored UTC coercion");
		},
	});
} else if (mode === "method") {
	const before = utc(2024, 0);
	Date.UTC = (...args) => {
		events.push(args.length);
		return args[7]?.label ?? 17;
	};
	result = [before, utc(2024, 0), extra(2024, { label: "extra" }), events];
} else if (mode === "global") {
	globalThis.Date = { UTC: (...args) => args.length };
	result = [utc(2024, 0), extra(2024, {})];
} else if (mode === "accessor") {
	Object.defineProperty(Date, "UTC", {
		configurable: true,
		get() {
			events.push("get");
			return (...args) => {
				events.push(args.length);
				return 23;
			};
		},
	});
	result = [utc(2024, 0), extra(2024, {}), events];
} else if (mode === "captured" || mode === "captured-extra") {
	const call = mode === "captured" ? captured : capturedExtra;
	result = [
		call(() => {
			events.push("argument");
			Date.UTC = () => 29;
			return 0;
		}),
		utc(2024, 0),
		events,
	];
} else if (mode === "prepared") {
	const year = {
		valueOf() {
			events.push("year");
			Date.UTC = () => 31;
			return 2024;
		},
	};
	result = [utc(year, 0), events];
} else if (mode === "argument-throw") {
	const thrown = { label: "UTC argument" };
	Date.UTC = () => {
		events.push("called");
		return 37;
	};
	try {
		capturedExtra(() => {
			events.push("argument");
			throw thrown;
		});
	} catch (error) {
		result = [error === thrown, events];
	}
} else if (mode === "unknown") {
	const year = {
		valueOf() {
			events.push("coerce");
			Date.UTC = () => 41;
			return 2024;
		},
	};
	result = [unknown(year), utc(2024, 0), events];
} else if (mode === "throws") {
	result = [];
	for (const value of [Symbol("year"), 2024n]) {
		try {
			unknown(value);
		} catch (error) {
			result.push(error.name);
		}
	}
} else if (mode === "shadow") {
	result = shadow({ UTC: () => 43 });
} else if (mode === "lexical") {
	const Date = { UTC: () => 47 };
	result = Date.UTC(2024, 0);
}
globalThis.Date = savedDate;
Object.defineProperty(Date, "UTC", {
	value: savedUtc,
	writable: true,
	configurable: true,
});
console.log(JSON.stringify(result));
