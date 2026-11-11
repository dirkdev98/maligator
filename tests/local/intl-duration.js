const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
function equal(actual, expected) {
	if (actual !== expected)
		throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function raises(Type, action) {
	try {
		action();
	} catch (error) {
		if (error instanceof Type) return;
		throw error;
	}
	throw new Error(`expected ${Type.name}`);
}
const scenario = process.env.DURATION_SCENARIO;
if (scenario === "protocol") {
	if (typeof collect !== "function") throw new Error("collecting hook unavailable");
	const reads = [];
	const duration = {};
	for (const field of [
		"days",
		"hours",
		"microseconds",
		"milliseconds",
		"minutes",
		"months",
		"nanoseconds",
		"seconds",
		"weeks",
		"years",
	]) {
		Object.defineProperty(duration, field, {
			get() {
				reads.push(field);
				collect();
				return {
					valueOf() {
						collect();
						return 1;
					},
				};
			},
		});
	}
	const formatter = new Intl.DurationFormat("en");
	formatter.format(duration);
	equal(
		reads.join(","),
		"days,hours,microseconds,milliseconds,minutes,months,nanoseconds,seconds,weeks,years",
	);
	const sentinel = new Error("late getter");
	let caught = false;
	try {
		formatter.format({
			days: -1,
			hours: 1,
			get years() {
				throw sentinel;
			},
		});
	} catch (error) {
		equal(error, sentinel);
		caught = true;
	}
	equal(caught, true);
	reads.length = 0;
	raises(RangeError, () =>
		formatter.format({
			get days() {
				reads.push("days");
				return 0.5;
			},
			get hours() {
				reads.push("hours");
				return 1;
			},
		}),
	);
	equal(reads.join(","), "days");
	raises(TypeError, () => formatter.format({}));
	equal(formatter.format("PT1S"), formatter.format({ seconds: 1 }));
	raises(RangeError, () => formatter.format("invalid"));
	raises(RangeError, () => formatter.format({ seconds: 1, nanoseconds: -1 }));
	const order = [];
	const newTarget = new Proxy(function () {}, {
		get(target, key) {
			if (key === "prototype") {
				order.push("prototype");
				collect();
			}
			return Reflect.get(target, key);
		},
	});
	Reflect.construct(
		Intl.DurationFormat,
		[
			{
				get length() {
					order.push("locales");
					collect();
					return 0;
				},
			},
			{
				get localeMatcher() {
					order.push("options");
					collect();
					return "lookup";
				},
			},
		],
		newTarget,
	);
	equal(order.join(","), "prototype,locales,options");
	console.log("ok");
} else if (scenario === "pinned_parts") {
	const record = { seconds: 1, milliseconds: 234, microseconds: 56, nanoseconds: 7 };
	const formatter = new Intl.DurationFormat("he", { style: "long" });
	const parts = formatter.formatToParts(record);
	equal(parts.map((part) => part.value).join(""), formatter.format(record));
	equal(
		JSON.stringify(
			parts
				.filter((part) => part.type === "literal" && !Object.hasOwn(part, "unit"))
				.map((part) => part.value),
		),
		JSON.stringify([", ", ", ", ", "]),
	);
	equal(
		JSON.stringify(parts.filter((part) => part.type === "unit").map((part) => part.unit)),
		JSON.stringify(Object.keys(record).map((key) => key.slice(0, -1))),
	);
	console.log("ok");
} else if (scenario === "bounds") {
	const formatter = new Intl.DurationFormat("en");
	for (const field of ["years", "months", "weeks"]) {
		formatter.format({ [field]: 2 ** 32 - 1 });
		raises(RangeError, () => formatter.format({ [field]: 2 ** 32 }));
	}
	for (const value of [Infinity, NaN, 1e100, 2 ** 128, Number.MAX_VALUE]) {
		raises(RangeError, () => formatter.format({ nanoseconds: value }));
	}
	formatter.format({ seconds: 2 ** 53 - 1, nanoseconds: 999999999 });
	raises(RangeError, () => formatter.format({ seconds: 2 ** 53 }));
	raises(RangeError, () =>
		formatter.format({ seconds: 2 ** 53 - 1, nanoseconds: 1000000000 }),
	);
	const wide = new Intl.DurationFormat("en", { nanoseconds: "long" });
	equal(wide.format({ nanoseconds: 2 ** 64 }), "18,446,744,073,709,551,616 nanoseconds");
	equal(
		new Intl.DurationFormat("en", { style: "digital" }).format({
			nanoseconds: 2 ** 64,
		}),
		"0:00:18446744073.709551616",
	);
	const mixed = new Intl.DurationFormat("en", {
		hours: "numeric",
		hoursDisplay: "auto",
		minutesDisplay: "auto",
		secondsDisplay: "auto",
	});
	equal(
		mixed.format({
			years: 1,
			days: 2,
			minutes: 3,
			seconds: 4,
			nanoseconds: 125000000,
		}),
		"1 yr, 2 days, 03:04.125",
	);
	const upper = new Intl.DurationFormat("en", { numberingSystem: "ARAB" });
	equal(upper.resolvedOptions().numberingSystem, "arab");
	equal(
		upper.format({ seconds: 12 }),
		new Intl.DurationFormat("en", { numberingSystem: "arab" }).format({
			seconds: 12,
		}),
	);
	for (const [system, zero] of [
		["fullwide", 0xff10],
		["mathsans", 0x1d7e2],
		["ahom", 0x11730],
		["cakm", 0x11136],
	]) {
		const localize = (text) =>
			Array.from(text, (ch) =>
				ch >= "0" && ch <= "9" ? String.fromCodePoint(zero + Number(ch)) : ch,
			).join("");
		const numeric = new Intl.DurationFormat("en", {
			style: "digital",
			numberingSystem: system,
		});
		equal(numeric.resolvedOptions().numberingSystem, system);
		equal(numeric.format({ seconds: 1234567890 }), localize("0:00:1234567890"));
		const text = new Intl.DurationFormat("en", {
			style: "long",
			numberingSystem: system,
		});
		equal(text.format({ seconds: 1234567890 }), localize("1,234,567,890 seconds"));
	}
	equal(
		new Intl.DurationFormat("af", { minutes: "numeric" }).format({
			minutes: 1,
			seconds: 2,
		}),
		"1:02",
	);

	console.log("ok");
} else {
	const results = [];
	for (const locale of ["en", "fr", "ja"]) {
		for (const options of [
			{ style: "long" },
			{ style: "short" },
			{ style: "narrow" },
			{ style: "digital" },
			{ style: "digital", fractionalDigits: 5 },
			{ hours: "numeric", years: "long", days: "narrow" },
			{ seconds: "long", milliseconds: "numeric" },
			{ milliseconds: "long", microseconds: "numeric" },
			{
				hours: "numeric",
				hoursDisplay: "auto",
				minutesDisplay: "auto",
				secondsDisplay: "auto",
			},
		]) {
			const formatter = new Intl.DurationFormat(locale, options);
			for (const duration of [
				{ seconds: 0 },
				{ hours: 1234, minutes: 2, seconds: 3 },
				{ nanoseconds: 1000000000 },
				{ microseconds: 1000000 },
				{ milliseconds: 100 },
				{ microseconds: 100 },
				{ seconds: -1, milliseconds: -234, microseconds: -500 },
				{ years: 1, days: 2, minutes: 3, seconds: 4, nanoseconds: 125000000 },
			]) {
				const text = formatter.format(duration);
				if (options.hoursDisplay === "auto" && duration.years === 1) continue;
				if (scenario === "parts") {
					const parts = formatter.formatToParts(duration);
					equal(parts.map((part) => part.value).join(""), text);
					results.push(parts);
				} else results.push(text);
			}
		}
	}

	if (scenario === "parts") {
		for (const locale of ["ar", "he", "ko"])
			for (const style of ["long", "short", "narrow", "digital"]) {
				const formatter = new Intl.DurationFormat(locale, { style });
				for (const duration of [
					{ hours: 1 },
					{ hours: 2 },
					{ minutes: -2 },
					{ seconds: 1, milliseconds: 234, microseconds: 56, nanoseconds: 7 },
				]) {
					// The pinned CLDR unit-long Hebrew list uses commas. Its data
					// and field annotations are checked outside Node's older oracle.
					if (locale === "he" && style === "long" && Object.keys(duration).length > 1)
						continue;
					const parts = formatter.formatToParts(duration);
					equal(parts.map((part) => part.value).join(""), formatter.format(duration));
					results.push(parts);
				}
			}
		const wide = {
			years: 4294967295,
			months: 4294967295,
			weeks: 4294967295,
			days: 1e9,
			hours: 1e10,
			minutes: 1e12,
			seconds: 1e14,
			milliseconds: 1e15,
			microseconds: 1e15,
			nanoseconds: 1e15,
		};
		for (const locale of ["en", "en-u-nu-mathsans"]) {
			const formatter = new Intl.DurationFormat(locale, { style: "long" });
			const parts = formatter.formatToParts(wide);
			equal(parts.map((part) => part.value).join(""), formatter.format(wide));
			results.push(parts);
		}
	}
	console.log(JSON.stringify(results));
}
