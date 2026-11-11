const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
function equal(actual, expected) {
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
const scenario = process.env.NUMBER_SCENARIO;
if (scenario === "exact") {
	const plain = new Intl.NumberFormat("en", {
		useGrouping: false,
		maximumFractionDigits: 3,
	});
	for (const [value, expected] of [
		["9007199254740993", "9007199254740993"],
		["0x20000000000001", "9007199254740993"],
		[
			"12345678901234567890123456789012345678901234567890",
			"12345678901234567890123456789012345678901234567890",
		],
		[1000000000000000128, "1000000000000000100"],
		["1000000000000000128", "1000000000000000128"],
		[
			-170141183460469231731687303715884105728n,
			"-170141183460469231731687303715884105728",
		],
		["\ufeff\u00a0.5\u2028", "0.5"],
		["1.", "1"],
		["1e+2", "100"],
		["", "0"],
		["-0", "-0"],
		["1" + "0".repeat(40000) + "e-40000", "1"],
		["0e99999999999999999999", "0"],
		["1.e+308", "1" + "0".repeat(308)],
		["1.e-324", "0"],
		["2.5e-324", "0"],
		["1.7976931348623159e308", "∞"],
		["-1e-999999999999999", "-0"],
		["1e99999999999999x", "NaN"],
		["+0x1", "NaN"],
		["0x" + "f".repeat(256), "∞"],
		["0x1" + "0".repeat(40000) + "q", "NaN"],
	])
		equal(plain.format(value), expected);
	const rounded = new Intl.NumberFormat("en", {
		maximumFractionDigits: 3,
		roundingMode: "halfEven",
	});
	equal(rounded.format("1.2345"), "1.234");
	equal(rounded.format("1.2345" + "0".repeat(40000) + "1"), "1.235");
	const percent = new Intl.NumberFormat("en", {
		style: "percent",
		maximumFractionDigits: 20,
	});
	equal(percent.format(0.29), "29%");
	const ceil = new Intl.NumberFormat("en", {
		useGrouping: false,
		maximumFractionDigits: 100,
		roundingMode: "ceil",
	});
	equal(ceil.format("1e-324"), "0");
	equal(ceil.format("1e-10000"), "0");
	equal(ceil.format("2.5e-324"), "0." + "0".repeat(99) + "1");
	const supplementary = new Intl.NumberFormat("en", {
		numberingSystem: "mathsans",
		useGrouping: false,
	});
	const localized = Array.from("123.5", (ch) =>
		ch >= "0" && ch <= "9" ? String.fromCodePoint(0x1d7e2 + Number(ch)) : ch,
	).join("");
	equal(supplementary.format(123.5), localized);
	equal(
		supplementary
			.formatToParts(123.5)
			.map((part) => part.value)
			.join(""),
		localized,
	);
	console.log("ok");
} else if (scenario === "protocol") {
	if (typeof collect !== "function") throw new Error("collecting hook unavailable");
	const events = [];
	const target = function () {};
	target.prototype = Intl.NumberFormat.prototype;
	const newTarget = new Proxy(target, {
		get(target, key) {
			if (key === "prototype") {
				events.push("prototype");
				collect();
			}
			return Reflect.get(target, key);
		},
	});
	const formatter = Reflect.construct(
		Intl.NumberFormat,
		[
			{
				get length() {
					events.push("locales");
					collect();
					return 0;
				},
			},
			{
				get minimumFractionDigits() {
					return {
						valueOf() {
							collect();
							return 1;
						},
					};
				},
				get maximumSignificantDigits() {
					collect();
					return undefined;
				},
			},
		],
		newTarget,
	);
	equal(events, ["prototype", "locales"]);
	const value = {
		[Symbol.toPrimitive](hint) {
			equal(hint, "number");
			events.push("primitive");
			collect();
			return "9007199254740993";
		},
	};
	equal(formatter.format(value), "9,007,199,254,740,993.0");
	equal(events, ["prototype", "locales", "primitive"]);
	const parts = formatter.formatToParts({
		[Symbol.toPrimitive](hint) {
			equal(hint, "number");
			collect();
			return 12345678901234567890n;
		},
	});
	equal(parts.map((part) => part.value).join(""), "12,345,678,901,234,567,890.0");
	equal(formatter.format, formatter.format);
	const order = [];
	new Intl.NumberFormat("en", {
		get minimumFractionDigits() {
			order.push("minimumFractionDigits");
			return {
				valueOf() {
					collect();
					order.push("fraction valueOf");
					return 0;
				},
			};
		},
		get roundingMode() {
			collect();
			order.push("roundingMode");
			return "halfEven";
		},
	});
	equal(order, ["minimumFractionDigits", "roundingMode", "fraction valueOf"]);
	const first = formatter.resolvedOptions();
	first.minimumFractionDigits = 90;
	collect();
	const second = formatter.resolvedOptions();
	equal(second.minimumFractionDigits, 1);
	equal(first === second, false);
	equal(Object.getPrototypeOf(second), Object.prototype);
	equal(
		Object.keys(second),
		[
			"locale",
			"numberingSystem",
			"style",
			"minimumIntegerDigits",
			"minimumFractionDigits",
			"maximumFractionDigits",
			"useGrouping",
			"notation",
			"signDisplay",
			"roundingIncrement",
			"roundingMode",
			"roundingPriority",
			"trailingZeroDisplay",
		].filter((key) => key in second),
	);
	console.log("ok");
} else {
	const results = [];
	results.push(
		[-0, 1e-7, 1e21, 1000000000000000128, 0.29].map((value) => value.toLocaleString()),
	);
	for (const locale of ["en", "de", "ar-u-nu-arab"]) {
		for (const options of [
			{},
			{ minimumIntegerDigits: 4, minimumFractionDigits: 2 },
			{ maximumSignificantDigits: 3, minimumSignificantDigits: 2 },
			{ useGrouping: "min2", signDisplay: "always" },
			...[null, 0, -0, NaN, 0n, ""].map((useGrouping) => ({ useGrouping })),
			{
				minimumSignificantDigits: 1,
				maximumSignificantDigits: 2,
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
				roundingPriority: "morePrecision",
				useGrouping: false,
			},
			{ maximumFractionDigits: 1, roundingMode: "halfEven" },
			{ maximumFractionDigits: 1, roundingMode: "ceil" },
			{ maximumFractionDigits: 1, roundingMode: "floor" },
			{ maximumFractionDigits: 1, roundingMode: "trunc" },
			{ maximumFractionDigits: 1, roundingMode: "expand" },
			{ maximumFractionDigits: 1, roundingMode: "halfCeil" },
			{ maximumFractionDigits: 1, roundingMode: "halfFloor" },
			{ maximumFractionDigits: 1, roundingMode: "halfTrunc" },

			{
				maximumSignificantDigits: 3,
				minimumSignificantDigits: 2,
				minimumFractionDigits: 1,
				maximumFractionDigits: 1,
				roundingPriority: "morePrecision",
			},
			{
				maximumSignificantDigits: 3,
				minimumSignificantDigits: 2,
				minimumFractionDigits: 1,
				maximumFractionDigits: 1,
				roundingPriority: "lessPrecision",
			},
			{
				minimumFractionDigits: 2,
				maximumFractionDigits: 3,
				trailingZeroDisplay: "stripIfInteger",
			},
			...[2, 5, 25, 50, 100, 250, 500, 2500, 5000].map((roundingIncrement) => ({
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
				roundingIncrement,
			})),
		]) {
			const formatter = new Intl.NumberFormat(locale, options);
			for (const value of [
				-0,
				-1234.55,
				0.001,
				1.25,
				999.95,
				"9007199254740993",
				9876543210n,
			]) {
				const text = formatter.format(value);
				const parts = formatter.formatToParts(value);
				equal(parts.map((part) => part.value).join(""), text);
				results.push([text, parts]);
			}
		}
	}
	for (const signDisplay of ["auto", "always", "never", "exceptZero", "negative"]) {
		const formatter = new Intl.NumberFormat("en", { signDisplay });
		for (const value of [NaN, Infinity, -Infinity])
			results.push([formatter.format(value), formatter.formatToParts(value)]);
	}
	console.log(JSON.stringify(results));
}
