const collect = globalThis.__mal_collect_garbage ?? globalThis.gc ?? (() => {});

if (process.env.LIST_SCENARIO === "empty") {
	const formatter = new Intl.ListFormat("en");
	const cases = [
		[[], "", []],
		[[""], "", [{ type: "element", value: "" }]],
		[
			["", ""],
			" and ",
			[
				{ type: "element", value: "" },
				{ type: "literal", value: " and " },
				{ type: "element", value: "" },
			],
		],
		[
			["a", "", "b"],
			"a, , and b",
			[
				{ type: "element", value: "a" },
				{ type: "literal", value: ", " },
				{ type: "element", value: "" },
				{ type: "literal", value: ", and " },
				{ type: "element", value: "b" },
			],
		],
	];
	for (const [input, text, parts] of cases) {
		if (
			formatter.format(input) !== text ||
			JSON.stringify(formatter.formatToParts(input)) !== JSON.stringify(parts)
		)
			throw new Error("empty element part was lost");
	}
	console.log("ok");
} else if (process.env.LIST_SCENARIO === "hebrew") {
	const formatter = new Intl.ListFormat("he");
	for (const [last, literal] of [
		["Iris", " ו‑"],
		["ישראל", " ו"],
		["\ud800", " ו‑"],
	]) {
		const parts = [
			{ type: "element", value: "Alder" },
			{ type: "literal", value: literal },
			{ type: "element", value: last },
		];
		if (
			formatter.format(["Alder", last]) !== "Alder" + literal + last ||
			JSON.stringify(formatter.formatToParts(["Alder", last])) !== JSON.stringify(parts)
		)
			throw new Error("Hebrew conditional conjunction changed");
	}
	console.log("ok");
} else if (process.env.LIST_SCENARIO === "protocol") {
	const events = [];
	const prototype = Object.create(Intl.ListFormat.prototype);
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
		0: "es",
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
	const formatter = Reflect.construct(Intl.ListFormat, [locales, options], Target);
	if (Object.getPrototypeOf(formatter) !== prototype) throw new Error("prototype lost");
	if (events.join(",") !== "prototype,locales,localeMatcher,type,style")
		throw new Error("constructor order changed");
	const longLocale = "en-x-" + Array(20).fill("abcdefgh").join("-");
	if (new Intl.ListFormat(longLocale).format(["Alder", "Birch"]) !== "Alder and Birch")
		throw new Error("long locale could not construct or format");
	for (const method of ["format", "formatToParts"]) {
		let closed = 0;
		function* invalid() {
			try {
				yield "Alder";
				collect();
				yield 1;
			} finally {
				closed++;
				collect();
			}
		}
		let rejected = false;
		try {
			formatter[method](invalid());
		} catch (error) {
			rejected = error instanceof TypeError;
		}
		if (!rejected || closed !== 1)
			throw new Error("invalid element did not close iterator");
		const steps = [];
		function* valid() {
			steps.push("first");
			yield "\ud800";
			collect();
			steps.push("done");
		}
		const value = formatter[method](valid());
		const text = method === "format" ? value : value.map((part) => part.value).join("");
		if (text !== "\ud800" || steps.join(",") !== "first,done")
			throw new Error("singleton bypassed iterable validation");
	}
	console.log("ok");
} else {
	function digest(text) {
		let value = 0x811c9dc5;
		for (let i = 0; i < text.length; i++)
			value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
		return value >>> 0;
	}
	const inputs = [
		[],
		["Alder"],
		["\ud800", "\udfff", "🌲"],
		[" and ", " and ", "and"],
		["Alder", "Iris"],
		["Alder", "ישראל"],
		Array.from({ length: 160 }, (_, i) => `${i}:` + "café東京".repeat(16)),
	];
	const output = [];
	for (const locale of ["en", "es", "ja"]) {
		for (const type of ["conjunction", "disjunction", "unit"]) {
			for (const style of ["long", "short", "narrow"]) {
				const formatter = new Intl.ListFormat(locale, { type, style });
				for (const input of inputs) {
					if (
						input.length > 16 &&
						(locale !== "en" || type !== "conjunction" || style !== "long")
					)
						continue;
					const text = formatter.format(input);
					const parts = formatter.formatToParts(input);
					if (parts.map((part) => part.value).join("") !== text)
						throw new Error("parts do not reproduce formatted text");
					const elements = parts.filter((part) => part.type === "element");
					if (
						JSON.stringify(elements.map((part) => part.value)) !== JSON.stringify(input)
					)
						throw new Error("elements changed or disappeared");
					output.push([
						text.length,
						digest(text),
						parts.length,
						digest(JSON.stringify(parts)),
					]);
				}
				collect();
			}
		}
	}
	console.log(JSON.stringify(output));
}
