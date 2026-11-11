const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
function equal(actual, expected) {
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
const results = [];
if (process.env.UNIT_SCENARIO === "protocol") {
	if (typeof collect !== "function") throw new Error("collecting hook unavailable");
	const events = [];
	const options = {
		style: "unit",
		get currency() {
			events.push("currency");
			return {
				toString() {
					collect();
					return "usd";
				},
			};
		},
		get currencyDisplay() {
			events.push("currencyDisplay");
			collect();
			return "symbol";
		},
		get currencySign() {
			events.push("currencySign");
			collect();
			return "standard";
		},
		get unit() {
			events.push("unit");
			return {
				toString() {
					collect();
					return "meter-per-mile";
				},
			};
		},
		get unitDisplay() {
			events.push("unitDisplay");
			collect();
			return "long";
		},
		get maximumFractionDigits() {
			events.push("digits");
			collect();
			return 3;
		},
	};
	const formatter = new Intl.NumberFormat("en", options);
	equal(events, [
		"currency",
		"currencyDisplay",
		"currencySign",
		"unit",
		"unitDisplay",
		"digits",
	]);
	let conversions = 0;
	const input = {
		[Symbol.toPrimitive](hint) {
			equal(hint, "number");
			conversions++;
			collect();
			return "1e308";
		},
	};
	const parts = formatter.formatToParts(input);
	equal(conversions, 1);
	equal(parts.map((p) => p.value).join(""), formatter.format("1e308"));
	const first = formatter.resolvedOptions();
	first.unit = "hour";
	collect();
	equal(formatter.resolvedOptions().unit, "meter-per-mile");
	equal(formatter.resolvedOptions().unitDisplay, "long");
	results.push(parts, formatter.format(2));
	for (const options of [
		{ style: "unit" },
		{ style: "unit", unit: "Meter" },
		{ style: "unit", unit: "meter-per-byte-per-second" },
		{ unit: "nonsense" },
		{ unitDisplay: "LONG" },
		{ currency: "US" },
	]) {
		try {
			new Intl.NumberFormat("en", options);
			throw new Error("accepted invalid unit options");
		} catch (error) {
			if (!(error instanceof RangeError) && !(error instanceof TypeError)) throw error;
			results.push(error.name);
		}
	}
	equal(
		new Intl.NumberFormat("en", {
			style: "unit",
			unit: "percent",
			unitDisplay: "narrow",
		}).format(0.29),
		"0.29%",
	);
} else if (process.env.UNIT_SCENARIO === "pinned") {
	const cases = [
		[
			"en",
			"short",
			2,
			[
				{ type: "integer", value: "2" },
				{ type: "unit", value: "%/byte" },
			],
		],
		[
			"en",
			"narrow",
			0.29,
			[
				{ type: "integer", value: "0" },
				{ type: "decimal", value: "." },
				{ type: "fraction", value: "29" },
				{ type: "unit", value: "%/B" },
			],
		],
		[
			"de",
			"short",
			2,
			[
				{ type: "integer", value: "2" },
				{ type: "literal", value: " " },
				{ type: "unit", value: "%/Byte" },
			],
		],
	];
	for (const [locale, unitDisplay, value, expected] of cases) {
		const formatter = new Intl.NumberFormat(locale, {
			style: "unit",
			unit: "percent-per-byte",
			unitDisplay,
		});
		equal(formatter.formatToParts(value), expected);
		equal(formatter.format(value), expected.map((part) => part.value).join(""));
	}
	results.push("ok");
} else {
	const units = Intl.supportedValuesOf("unit");
	results.push(units);
	const cases = [];
	for (const unit of units)
		for (const unitDisplay of ["long", "short", "narrow"])
			cases.push(["en", unit, unitDisplay]);
	for (const locale of ["de", "fr", "ar", "he", "ko", "ja"])
		for (const unit of [
			"hour",
			"meter-per-mile",
			"kilometer-per-hour",
			"percent-per-byte",
			"fluid-ounce-per-liter",
		])
			for (const unitDisplay of ["long", "short", "narrow"]) {
				// The pinned Node oracle drops short percent-compound denominators;
				// separate CLDR holdouts retain those labels and unscaled values.
				if (unit === "percent-per-byte" && unitDisplay !== "long") continue;
				cases.push([locale, unit, unitDisplay]);
			}
	for (const [locale, unit, unitDisplay] of cases) {
		const formatter = new Intl.NumberFormat(locale, {
			style: "unit",
			unit,
			unitDisplay,
			maximumFractionDigits: 3,
		});
		for (const value of [1, 2, -2, 1.25]) {
			const text = formatter.format(value),
				parts = formatter.formatToParts(value);
			equal(parts.map((p) => p.value).join(""), text);
			for (const part of parts)
				if (Object.hasOwn(part, "unit"))
					throw new Error("NumberFormat part has a duration unit field");
			results.push([locale, unit, unitDisplay, value, text, parts]);
		}
	}
}
console.log(JSON.stringify(results));
