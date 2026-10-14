const mode = process.env.SPAN_LOCALE_COMPARE_MODE ?? "range";
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function observed(value) {
	collectGarbage();
	return "observed:" + value;
}
function range(source, start, end, that, locales, options, escape) {
	const part = source.slice(start, end);
	const result = part.localeCompare(that, locales, options);
	collectGarbage();
	return escape ? [Math.sign(result), escape(part), escape(part)] : [Math.sign(result)];
}
function split(source, start, end, that, locales, options, escape) {
	const part = source.split("|")[1];
	const result = part.localeCompare(that, locales, options);
	collectGarbage();
	return escape ? [Math.sign(result), escape(part), escape(part)] : [Math.sign(result)];
}
function capture(source, start, end, that, locales, options, escape) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	const result = part.localeCompare(that, locales, options);
	collectGarbage();
	return escape ? [Math.sign(result), escape(part), escape(part)] : [Math.sign(result)];
}
function nested(source, start, end, that, locales, options, escape) {
	const parent = source.slice(start, end);
	const part = parent.trim();
	const result = part.localeCompare(that, locales, options);
	collectGarbage();
	return escape
		? [Math.sign(result), escape(part), escape(parent), escape(part)]
		: [Math.sign(result)];
}
function prepared(source, start, end, that, escape) {
	const part = String(source).slice(start, end).trim();
	const result = part.localeCompare(that, "en");
	collectGarbage();
	return escape ? [Math.sign(result), escape(part), escape(part)] : [Math.sign(result)];
}
function preparedSplit(source, that) {
	const part = source.split("|")[1];
	return Math.sign(String.prototype.localeCompare.call(part, that, "en"));
}
function preparedCapture(source, that) {
	const part = /\|([^|]*)\|/.exec(source)[1];
	return Math.sign(String.prototype.localeCompare.call(part, that, "en"));
}
function extra(source, that, locales, options, effect) {
	const part = source.slice(1, -1);
	return Math.sign(part.localeCompare(that, locales, options, effect()));
}
globalThis.compareRange = range;
globalThis.compareSplit = split;
globalThis.compareCapture = capture;
globalThis.compareNested = nested;
globalThis.comparePrepared = prepared;
globalThis.compareExtra = extra;
globalThis.comparePreparedSplit = preparedSplit;
globalThis.comparePreparedCapture = preparedCapture;
const rows = [];
if (mode === "bounded") {
	const prefix = "x".repeat(16384),
		suffix = "y".repeat(16384);
	const left = prefix + "e",
		right = "\u0301" + suffix,
		source = left + right;
	rows.push(
		globalThis.compareRange(
			source,
			prefix.length,
			prefix.length + 2,
			"é",
			undefined,
			undefined,
			false,
		),
	);
	rows.push(
		globalThis.comparePrepared(source, prefix.length, prefix.length + 2, "é", false),
	);
	collectGarbage();
} else if (mode === "disabled") {
	const values = [
		["A", "a", -1],
		["10", "2", -1],
		["\ud800", "\udc00", -1],
		["", "", 0],
	];
	for (const [left, right, expected] of values) {
		const ignored = {
			get length() {
				throw new Error("disabled locale");
			},
		};
		const result = globalThis.compareRange(
			"x" + left + "y",
			1,
			left.length + 1,
			right,
			ignored,
			ignored,
			false,
		)[0];
		const cached = globalThis.comparePrepared(
			"x" + left + "y",
			1,
			left.length + 1,
			right,
			false,
		)[0];
		if (result !== expected || cached !== expected) throw new Error("disabled collation");
	}
	rows.push("disabled PASS");
} else if (mode === "fallback") {
	const events = [];
	const marker = { marker: true };
	const that = {
		toString() {
			events.push("that");
			collectGarbage();
			return "a";
		},
	};
	const locales = {
		get length() {
			events.push("locales");
			collectGarbage();
			return 1;
		},
		get 0() {
			events.push("locale");
			return "en";
		},
	};
	const options = {
		get sensitivity() {
			events.push("sensitivity");
			collectGarbage();
			return "base";
		},
		numeric: true,
	};
	rows.push(
		globalThis.compareExtra("xAy", that, locales, options, () => {
			events.push("extra");
			return Symbol();
		}),
		events,
	);
	if (
		events[0] !== "extra" ||
		events.indexOf("that") > events.indexOf("locales") ||
		events.indexOf("locales") > events.indexOf("sensitivity")
	)
		throw new Error("coercion order");
	let throws = 0;
	for (const errorThat of [
		Symbol(),
		{
			toString() {
				collectGarbage();
				throw marker;
			},
		},
	]) {
		try {
			globalThis.compareRange(
				"xay",
				1,
				2,
				errorThat,
				{
					get length() {
						throw new Error("late locale");
					},
				},
				undefined,
				false,
			);
		} catch (error) {
			if (error === marker || error instanceof TypeError) throws++;
			else throw error;
		}
	}
	try {
		globalThis.compareExtra("xay", "a", undefined, undefined, () => {
			throw marker;
		});
	} catch (error) {
		if (error === marker) throws++;
		else throw error;
	}
	try {
		globalThis.compareRange("xy", 1, 1, "", ["bad_tag"], undefined, false);
	} catch (error) {
		if (error instanceof RangeError) throws++;
		else throw error;
	}
	const throwOptions = {
		get sensitivity() {
			collectGarbage();
			throw marker;
		},
	};
	try {
		globalThis.compareRange("xay", 1, 2, "a", "en", throwOptions, false);
	} catch (error) {
		if (error === marker) throws++;
		else throw error;
	}
	for (const visit of [
		() => globalThis.compareSplit("missing", 0, 1, "x", undefined, undefined, false),
		() => globalThis.comparePreparedCapture("missing", "x"),
	]) {
		try {
			visit();
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
			throws++;
		}
	}
	if (throws !== 7) throw new Error("throw identity/count");
	rows.push(throws);
	const custom = {
		slice() {
			events.push("slice");
			return {
				[Symbol.toPrimitive](hint) {
					events.push("receiver:" + hint);
					collectGarbage();
					return "A";
				},
				localeCompare: String.prototype.localeCompare,
			};
		},
	};
	rows.push(globalThis.compareRange(custom, 1, 2, that, locales, options, false), events);
	if (process.env.SPAN_LOCALE_COMPARE_PRIMORDIALS === "mutable") {
		const original = String.prototype.localeCompare;
		const replacement = function () {
			return 41;
		};
		try {
			const changing = {
				get length() {
					String.prototype.localeCompare = replacement;
					collectGarbage();
					return 0;
				},
			};
			rows.push(globalThis.compareRange("xay", 1, 2, "a", changing, undefined, false));
			rows.push(globalThis.compareRange("xay", 1, 2, "a", undefined, undefined, false));
			String.prototype.localeCompare = String.prototype.indexOf;
			rows.push(globalThis.compareRange("xaby", 1, 3, "b", undefined, undefined, false));
		} finally {
			String.prototype.localeCompare = original;
		}
	}
} else {
	const visit = {
		range: globalThis.compareRange,
		split: globalThis.compareSplit,
		regexp: globalThis.compareCapture,
		nested: globalThis.compareNested,
		prepared: globalThis.comparePrepared,
	}[mode];
	if (!visit) throw new Error("mode");
	const pairs = [
		["", ""],
		["abc", "abd"],
		["é", "e\u0301"],
		["ä", "z"],
		["I", "ı"],
		["2", "10"],
		["ß", "ss"],
		["\ud800", "\ud800"],
		["\udc00", "\udc00"],
		["😀", "😁"],
	];
	for (const [left, right] of pairs) {
		if (mode === "prepared")
			rows.push(
				globalThis.comparePreparedSplit("|" + left + "|", right),
				globalThis.comparePreparedCapture("|" + left + "|", right),
			);
		for (const locale of ["en", "sv", "tr"]) {
			const text = mode === "nested" ? "  " + left + "  " : left;
			const source =
				mode === "split" || mode === "regexp" ? "|" + text + "|" : "x" + text + "y";
			rows.push(
				mode === "prepared"
					? visit(source, 1, text.length + 1, right, observed)
					: visit(
							source,
							1,
							text.length + 1,
							right,
							locale,
							{ sensitivity: "variant", numeric: true },
							observed,
						),
			);
		}
	}
	// A cut pair must remain an unpaired code unit, even when its source has the other half.
	if (mode === "range" || mode === "prepared") {
		rows.push(
			mode === "prepared"
				? visit("x\ud83d\ude00y", 1, 2, "\ud83d", observed)
				: visit("x\ud83d\ude00y", 1, 2, "\ud83d", "en", undefined, observed),
		);
	}
	let rope = "";
	for (let i = 0; i < 16; i++) rope += "éABC😀";
	const text = mode === "nested" ? " " + rope + " " : rope;
	const source =
		mode === "split" || mode === "regexp" ? "|" + text + "|" : "x" + text + "y";
	rows.push(
		mode === "prepared"
			? visit(source, 1, text.length + 1, rope, observed)
			: visit(source, 1, text.length + 1, rope, "en", undefined, observed),
	);
}
console.log(JSON.stringify(rows));
