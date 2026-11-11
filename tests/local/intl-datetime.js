const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});
const scenario = process.env.DATETIME_SCENARIO;
const rows = [];
const epoch = Date.UTC(2023, 10, 14, 13, 45, 6);
function parts(formatter, value) {
	const result = formatter.formatToParts(value);
	if (result.map((part) => part.value).join("") !== formatter.format(value))
		throw new Error("date parts must reconstruct formatted text");
	return result;
}
if (scenario === "styles") {
	for (const locale of ["en-US", "de-DE", "fr-FR", "ja-JP", "ar-EG", "fa-IR"])
		for (const options of [
			{ dateStyle: "medium" },
			{ dateStyle: "short" },
			{ timeStyle: "medium" },
			{ timeStyle: "short" },
			{ dateStyle: "medium", timeStyle: "medium" },
		]) {
			if (locale === "en-US" && options.timeStyle !== undefined) continue;
			rows.push([
				locale,
				options,
				parts(new Intl.DateTimeFormat(locale, options), epoch),
			]);
		}
} else if (scenario === "pinned") {
	const date = [
		{ type: "month", value: "Nov" },
		{ type: "literal", value: " " },
		{ type: "day", value: "14" },
		{ type: "literal", value: ", " },
		{ type: "year", value: "2023" },
	];
	const clock = [
		{ type: "hour", value: "1" },
		{ type: "literal", value: ":" },
		{ type: "minute", value: "45" },
		{ type: "literal", value: ":" },
		{ type: "second", value: "06" },
		{ type: "literal", value: "\u202f" },
		{ type: "dayPeriod", value: "PM" },
	];
	// Bundled CLDR preserves its narrow no-break separator before the day period.
	for (const [options, expected] of [
		[{ timeStyle: "medium" }, clock],
		[{ timeStyle: "short" }, [...clock.slice(0, 3), ...clock.slice(5)]],
		[
			{ dateStyle: "medium", timeStyle: "medium" },
			[...date, { type: "literal", value: ", " }, ...clock],
		],
	]) {
		const actual = parts(new Intl.DateTimeFormat("en-US", options), epoch);
		if (JSON.stringify(actual) !== JSON.stringify(expected))
			throw new Error("pinned date field boundary changed");
	}
	rows.push("ok");
} else if (scenario === "canonical_options") {
	const locale = "en-US-u-nu-arab";
	const upper = new Intl.DateTimeFormat(locale, {
		numberingSystem: "MATHBOLD",
		dateStyle: "medium",
	});
	const lower = new Intl.DateTimeFormat(locale, {
		numberingSystem: "mathbold",
		dateStyle: "medium",
	});
	// Explicit Unicode option values follow CanonicalizeUValue.
	if (
		upper.resolvedOptions().numberingSystem !== "mathbold" ||
		JSON.stringify(parts(upper, epoch)) !== JSON.stringify(parts(lower, epoch))
	)
		throw new Error("numbering option was not canonicalized");
	rows.push("ok");
} else if (scenario === "locale_methods") {
	for (const [method, locale, options] of [
		["toLocaleDateString", "en-US", { dateStyle: "medium" }],
		["toLocaleDateString", "en-US-u-ca-chinese-nu-arab", { dateStyle: "medium" }],
		[
			"toLocaleDateString",
			"en-US-u-ca-buddhist-nu-arab",
			{ calendar: "gregory", numberingSystem: "mathbold", dateStyle: "medium" },
		],
		["toLocaleTimeString", "ar-EG", { timeStyle: "short" }],
		[
			"toLocaleString",
			"en-US-u-ca-chinese-nu-arab",
			{
				calendar: "gregory",
				numberingSystem: "latn",
				dateStyle: "medium",
				timeStyle: "medium",
			},
		],
	]) {
		const actual = new Date(epoch)[method](locale, options);
		const expected = new Intl.DateTimeFormat(locale, options).format(epoch);
		rows.push([method, actual === expected]);
	}
} else if (scenario === "locale_protocol") {
	const events = [];
	const result = new Date(epoch).toLocaleDateString("en-US-u-ca-buddhist-nu-arab", {
		get calendar() {
			events.push("calendar");
			collect();
			return {
				toString() {
					events.push("calendar string");
					collect();
					return "gregory";
				},
			};
		},
		get numberingSystem() {
			events.push("numberingSystem");
			collect();
			return {
				toString() {
					events.push("numbering string");
					collect();
					return "latn";
				},
			};
		},
		get dateStyle() {
			events.push("dateStyle");
			collect();
			return "medium";
		},
	});
	rows.push([events, result]);
} else if (scenario === "locale_invalid") {
	for (const [method, options] of [
		["toLocaleDateString", { timeStyle: "short" }],
		["toLocaleTimeString", { dateStyle: "medium" }],
	]) {
		try {
			new Date(epoch)[method]("en", options);
			throw new Error("incompatible style accepted");
		} catch (error) {
			rows.push(error.name);
		}
	}
	rows.push(
		new Date(NaN).toLocaleDateString("en", {
			get calendar() {
				throw new Error("invalid Date must bypass options");
			},
		}),
	);
} else if (scenario === "options") {
	const locale = "en-US-u-ca-buddhist-nu-arab";
	for (const options of [
		{ calendar: "gregory", numberingSystem: "latn" },
		{ calendar: "CHINESE", numberingSystem: "mathbold" },
		{ calendar: "foobar", numberingSystem: "foobar" },
		{ calendar: "abc" + "-abc".repeat(80), numberingSystem: "abc" + "-abc".repeat(80) },
	]) {
		const formatter = new Intl.DateTimeFormat(locale, {
			...options,
			dateStyle: "medium",
		});
		const result = formatter.resolvedOptions();
		rows.push([result.calendar, result.numberingSystem, parts(formatter, epoch)]);
	}
} else if (scenario === "option_coercion") {
	const events = [];
	const formatter = new Intl.DateTimeFormat("en-US-u-ca-buddhist-nu-arab", {
		get calendar() {
			events.push("calendar");
			collect();
			return {
				toString() {
					events.push("calendar string");
					collect();
					return "gregory";
				},
			};
		},
		get numberingSystem() {
			events.push("numberingSystem");
			collect();
			return {
				toString() {
					events.push("numbering string");
					collect();
					return "latn";
				},
			};
		},
		get dateStyle() {
			events.push("dateStyle");
			collect();
			return "medium";
		},
	});
	rows.push([events, parts(formatter, epoch)]);
} else if (scenario === "invalid_options") {
	for (const options of [
		null,
		{ calendar: "" },
		{ calendar: "ab" },
		{ calendar: "abc_def" },
		{ numberingSystem: "ab" },
		{ calendar: Symbol() },
		{ numberingSystem: Symbol() },
	]) {
		try {
			new Intl.DateTimeFormat("en-US", options);
			throw new Error("invalid date options accepted");
		} catch (error) {
			rows.push(error.name);
		}
	}
} else if (scenario === "resolved") {
	for (const locale of [
		"en-US",
		"fa-IR",
		"ja-JP-u-ca-japanese",
		"en-US-u-ca-buddhist",
		"en-US-u-nu-mathbold",
		"ar-EG-u-nu-latn",
	]) {
		const result = new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
		}).resolvedOptions();
		rows.push([result.calendar, result.numberingSystem]);
	}
} else if (scenario === "calendars") {
	for (const locale of [
		"en-US-u-ca-buddhist",
		"ja-JP-u-ca-japanese",
		"ar-EG-u-nu-arab",
		"en-US-u-nu-mathbold",
	]) {
		const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
		rows.push([locale, parts(formatter, epoch)]);
	}
} else if (scenario === "clipping") {
	const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
	for (const value of [-1.9, -0.9, 0, 0.9, 1.9, -8640000000000000, 8640000000000000])
		rows.push([String(value), parts(formatter, value)]);
} else if (scenario === "invalid") {
	const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
	for (const value of [
		NaN,
		Infinity,
		-Infinity,
		8640000000000001,
		-8640000000000001,
		1n,
		Symbol(),
	]) {
		try {
			formatter.formatToParts(value);
			throw new Error("invalid date accepted");
		} catch (error) {
			rows.push(error.name);
		}
	}
} else if (scenario === "brand") {
	const method = Intl.DateTimeFormat.prototype.formatToParts;
	if (typeof method !== "function") throw new Error("date parts method is missing");
	let reads = 0;
	const input = {
		valueOf() {
			reads++;
			return epoch;
		},
	};
	for (const receiver of [
		undefined,
		null,
		{},
		new Date(),
		Intl.DateTimeFormat.prototype,
	]) {
		try {
			method.call(receiver, input);
			throw new Error("incompatible receiver accepted");
		} catch (error) {
			rows.push([error.name, reads]);
		}
	}
} else if (scenario === "coercion") {
	let formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
	const method = formatter.formatToParts;
	let reads = 0;
	const result = method.call(formatter, {
		[Symbol.toPrimitive](hint) {
			if (hint !== "number") throw new Error("wrong date coercion hint");
			reads++;
			formatter = null;
			collect();
			return epoch;
		},
	});
	rows.push([reads, result]);
	let owner = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
	const bound = owner.format;
	owner = null;
	collect();
	rows.push(
		bound({
			valueOf() {
				collect();
				return epoch;
			},
		}),
	);
} else if (scenario === "range_coercion") {
	const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
	for (const method of ["formatRange", "formatRangeToParts"]) {
		const events = [];
		const marker = new Error("end conversion");
		try {
			formatter[method](
				{
					valueOf() {
						events.push("start");
						collect();
						return NaN;
					},
				},
				{
					valueOf() {
						events.push("end");
						collect();
						throw marker;
					},
				},
			);
		} catch (error) {
			rows.push([events, error === marker]);
		}
	}
} else {
	throw new Error("unknown date-time scenario");
}
console.log(JSON.stringify(rows));
