const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});

if (process.env.RELATIVE_SCENARIO === "rounding") {
	const cases = [
		[Number.MIN_VALUE, "always", "in 0 days"],
		[-Number.MIN_VALUE, "auto", "0 days ago"],
		[0.0625, "always", "in 0.063 days"],
		[-0.0625, "always", "0.063 days ago"],
		[1.0625, "always", "in 1.063 days"],
		[1.2345, "always", "in 1.234 days"],
		[1.0004, "auto", "in 1 day"],
		[1.9999, "auto", "in 2 days"],
		[-0.0001, "auto", "0 days ago"],
		[0.0001, "auto", "in 0 days"],
		[-0, "auto", "today"],
		[-0, "always", "0 days ago"],
	];
	for (const [value, numeric, expected] of cases) {
		const formatter = new Intl.RelativeTimeFormat("en", { numeric });
		const text = formatter.format(value, "day");
		const parts = formatter.formatToParts(value, "days");
		collect();
		if (text !== expected || parts.map((part) => part.value).join("") !== expected)
			throw new Error("exact relative rounding or auto lookup changed");
	}
	console.log("ok");
} else if (process.env.RELATIVE_SCENARIO === "large") {
	for (const numberingSystem of ["latn", "adlm"]) {
		const formatter = new Intl.RelativeTimeFormat("en", { numberingSystem });
		if (formatter.resolvedOptions().numberingSystem !== numberingSystem)
			throw new Error("numbering system unavailable");
		const digits = (text) =>
			numberingSystem === "latn"
				? text
				: Array.from(text, (digit) =>
						String.fromCodePoint(0x1e950 + digit.charCodeAt(0) - 48),
					).join("");
		for (const [value, integer] of JSON.parse(process.env.RELATIVE_LARGE_CASES)) {
			const expected = value < 0 ? [] : [{ type: "literal", value: "in " }];
			let cursor = 0;
			while (cursor < integer.length) {
				const length = cursor === 0 ? integer.length % 3 || 3 : 3;
				if (cursor !== 0) expected.push({ type: "group", value: ",", unit: "year" });
				expected.push({
					type: "integer",
					value: digits(integer.slice(cursor, cursor + length)),
					unit: "year",
				});
				cursor += length;
			}
			expected.push({ type: "literal", value: value < 0 ? " years ago" : " years" });
			if (formatter.format(value, "year") !== expected.map((part) => part.value).join(""))
				throw new Error("large finite integer lost precision");
			const parts = formatter.formatToParts(value, "years");
			collect();
			if (JSON.stringify(parts) !== JSON.stringify(expected))
				throw new Error("large finite integer parts changed");
		}
	}
	console.log("ok");
} else if (process.env.RELATIVE_SCENARIO === "protocol") {
	const events = [];
	const prototype = Object.create(Intl.RelativeTimeFormat.prototype);
	const Target = new Proxy(function () {}, {
		get(target, key, receiver) {
			if (key === "prototype") {
				events.push("prototype");
				collect();
				return prototype;
			}
			return Reflect.get(target, key, receiver);
		},
	});
	const locales = {
		get length() {
			events.push("locales");
			collect();
			return 1;
		},
		0: "en",
	};
	const options = new Proxy(
		{},
		{
			get(_target, key) {
				events.push(key);
				collect();
				return undefined;
			},
		},
	);
	const formatter = Reflect.construct(
		Intl.RelativeTimeFormat,
		[locales, options],
		Target,
	);
	if (Object.getPrototypeOf(formatter) !== prototype) throw new Error("prototype lost");
	if (
		events.join(",") !== "prototype,locales,localeMatcher,numberingSystem,style,numeric"
	)
		throw new Error("constructor option order changed");
	for (const method of ["format", "formatToParts"]) {
		events.length = 0;
		const value = {
			valueOf() {
				events.push("number");
				collect();
				return 1.2344;
			},
		};
		const unit = {
			toString() {
				events.push("unit");
				collect();
				return "days";
			},
		};
		const result = formatter[method](value, unit);
		const text = method === "format" ? result : result.map((part) => part.value).join("");
		if (text !== "in 1.234 days" || events.join(",") !== "number,unit")
			throw new Error("formatting repeated or reordered coercion");
		const marker = {};
		let caught;
		try {
			formatter[method](Infinity, {
				toString() {
					collect();
					throw marker;
				},
			});
		} catch (error) {
			caught = error;
		}
		if (caught !== marker) throw new Error("nonfinite rejection bypassed unit coercion");
	}
	for (const [locale, numberingSystem, expectedLocale, expectedSystem] of [
		["en-u-nu-arab", "invalid", "en-u-nu-arab", "arab"],
		["en-u-nu-invalid", "invalid2", "en", "latn"],
		["en-u-nu-latn", "arab", "en", "arab"],
		["en-u-nu-arab", "arab", "en-u-nu-arab", "arab"],
	]) {
		const f = new Intl.RelativeTimeFormat(locale, {
			numberingSystem: {
				toString() {
					collect();
					return numberingSystem;
				},
			},
		});
		collect();
		const resolved = f.resolvedOptions();
		if (resolved.locale !== expectedLocale || resolved.numberingSystem !== expectedSystem)
			throw new Error("numbering system precedence changed");
	}
	let boxed;
	Object.defineProperty(Boolean.prototype, "localeMatcher", {
		configurable: true,
		get() {
			if (typeof this !== "object") throw new Error("options were not boxed");
			boxed = this;
			collect();
			return "lookup";
		},
	});
	Object.defineProperty(Boolean.prototype, "numberingSystem", {
		configurable: true,
		get() {
			if (this !== boxed) throw new Error("options were boxed more than once");
			collect();
			return "latn";
		},
	});
	try {
		new Intl.RelativeTimeFormat("en", true);
	} finally {
		delete Boolean.prototype.localeMatcher;
		delete Boolean.prototype.numberingSystem;
	}
	const longTag = "en-x-" + Array(20).fill("abcdefgh").join("-");
	if (
		new Intl.RelativeTimeFormat(longTag, {
			numberingSystem: Array(40).fill("abcd").join("-"),
		}).format(1, "day") !== "in 1 day"
	)
		throw new Error("long locale or unsupported numbering option failed");
	console.log("ok");
} else {
	function digest(text) {
		let value = 0x811c9dc5;
		for (let i = 0; i < text.length; i++)
			value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
		return value >>> 0;
	}
	const cases = [];
	const units = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"];
	for (const numeric of ["always", "auto"]) {
		const formatter = new Intl.RelativeTimeFormat("en", { numeric });
		for (let i = 0; i < units.length; i++) {
			for (const value of [-0, 0, -1, 1, 0.1, 1.2344])
				cases.push([formatter, value, units[i] + (i & 1 ? "s" : "")]);
		}
	}
	for (const locale of ["en", "pl", "ar-u-nu-arab"]) {
		for (const style of ["long", "short", "narrow"])
			cases.push([new Intl.RelativeTimeFormat(locale, { style }), 1234.5675, "days"]);
	}

	const output = [];
	for (const [formatter, value, unit] of cases) {
		const text = formatter.format(value, unit);
		const parts = formatter.formatToParts(value, unit);
		collect();
		if (parts.map((part) => part.value).join("") !== text)
			throw new Error("parts changed the formatted text");
		const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
		for (const part of parts) {
			if (part.type === "literal" ? Object.hasOwn(part, "unit") : part.unit !== singular)
				throw new Error("parts did not normalize the unit");
		}
		output.push([
			formatter.resolvedOptions(),
			text.length,
			digest(text),
			parts.length,
			digest(JSON.stringify(parts)),
		]);
	}
	console.log(JSON.stringify(output));
}
