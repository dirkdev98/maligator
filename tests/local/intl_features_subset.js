// engine.intl.features subset fixture. Built with the "core" services
// (collator, number-format, date-time-format, plural-rules, list-format) selected
// and the heavy/rare ones (segmenter, display-names, relative-time-format,
// duration-format) dropped. Asserts the selected services are present + localized
// and the dropped ones are absent (their Intl.X is undefined), while the
// non-namespace methods of selected services still localize.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

// Selected services present + localized.
check("Intl present", typeof Intl === "object");
check(
	"NumberFormat localized",
	new Intl.NumberFormat("de-DE").format(1234.5) === "1.234,5",
);

function throws(errorType, callback) {
	try {
		callback();
	} catch (error) {
		return error instanceof errorType;
	}
	return false;
}

check(
	"NumberFormat null options",
	throws(TypeError, () => new Intl.NumberFormat(undefined, null)),
);
check(
	"NumberFormat getter error",
	throws(
		SyntaxError,
		() =>
			new Intl.NumberFormat(undefined, {
				get minimumIntegerDigits() {
					throw new SyntaxError("digit getter");
				},
			}),
	),
);
check(
	"NumberFormat digit ranges",
	throws(
		RangeError,
		() => new Intl.NumberFormat(undefined, { minimumIntegerDigits: Infinity }),
	) &&
		throws(
			RangeError,
			() => new Intl.NumberFormat(undefined, { minimumFractionDigits: NaN }),
		) &&
		throws(
			RangeError,
			() => new Intl.NumberFormat(undefined, { maximumFractionDigits: -1 }),
		) &&
		throws(
			RangeError,
			() =>
				new Intl.NumberFormat(undefined, {
					minimumFractionDigits: 3,
					maximumFractionDigits: 2,
				}),
		),
);

const decimalDigits = new Intl.NumberFormat("en", {
	minimumFractionDigits: 5,
}).resolvedOptions();
const percentDigits = new Intl.NumberFormat("en", {
	style: "percent",
	minimumFractionDigits: 2,
}).resolvedOptions();
check(
	"NumberFormat digit defaults",
	decimalDigits.minimumFractionDigits === 5 &&
		decimalDigits.maximumFractionDigits === 5 &&
		percentDigits.minimumFractionDigits === 2 &&
		percentDigits.maximumFractionDigits === 2,
);
const supportedDigitsFormat = new Intl.NumberFormat("en", {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
	useGrouping: false,
}).format(7);
check("NumberFormat supported fraction format", supportedDigitsFormat === "7.00");
const cachedNumberFormat = new Intl.NumberFormat("de-DE", {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
	useGrouping: true,
});
const cachedNumberFormatFunction = cachedNumberFormat.format;
check(
	"NumberFormat persistent native plan",
	cachedNumberFormatFunction === cachedNumberFormat.format &&
		cachedNumberFormatFunction(1234.5) === "1.234,50" &&
		cachedNumberFormatFunction(7) === "7,00",
);
const mutableNumberOptions = cachedNumberFormat.resolvedOptions();
mutableNumberOptions.minimumFractionDigits = 0;
check(
	"NumberFormat resolvedOptions copy does not alter plan",
	cachedNumberFormatFunction(7) === "7,00" &&
		cachedNumberFormat.resolvedOptions().minimumFractionDigits === 2,
);
check(
	"NumberFormat unsupported style rejected",
	throws(RangeError, () => new Intl.NumberFormat(undefined, { style: "invalid" })),
);

let optionOrder = "";
new Intl.NumberFormat(undefined, {
	get style() {
		optionOrder += "s";
		return "decimal";
	},
	get minimumIntegerDigits() {
		optionOrder += "i";
		return 1;
	},
	get minimumFractionDigits() {
		optionOrder += "n";
		return 0;
	},
	get maximumFractionDigits() {
		optionOrder += "x";
		return 3;
	},
	get useGrouping() {
		optionOrder += "g";
		return true;
	},
});
check("NumberFormat option order", optionOrder === "sinxg");

Object.defineProperty(Number.prototype, "minimumIntegerDigits", {
	configurable: true,
	get() {
		return this instanceof Number ? 4 : 5;
	},
});
check(
	"NumberFormat primitive options",
	new Intl.NumberFormat(undefined, 0).resolvedOptions().minimumIntegerDigits === 4,
);
delete Number.prototype.minimumIntegerDigits;

Object.defineProperty(Object.prototype, "minimumIntegerDigits", {
	configurable: true,
	get() {
		throw new Error("undefined options observed Object.prototype");
	},
});
let undefinedOptionsWork = true;
try {
	new Intl.NumberFormat(undefined, undefined);
} catch {
	undefinedOptionsWork = false;
}
delete Object.prototype.minimumIntegerDigits;
check("NumberFormat undefined options bag", undefinedOptionsWork);

check("Collator present", typeof Intl.Collator === "function");
check("localeCompare (collator)", "b".localeCompare("a") === 1);
const localeCompareOrder = [];
const localeCompareResult = String.prototype.localeCompare.call(
	{
		toString() {
			localeCompareOrder.push("receiver");
			return ["same-", "s".repeat(96)].join("");
		},
	},
	{
		toString() {
			localeCompareOrder.push("that");
			if (typeof $262 !== "undefined") $262.gc();
			return ["same-", "s".repeat(96)].join("");
		},
	},
	{
		get length() {
			localeCompareOrder.push("locales");
			if (typeof $262 !== "undefined") $262.gc();
			return 0;
		},
	},
	{
		get usage() {
			localeCompareOrder.push("options");
			if (typeof $262 !== "undefined") $262.gc();
			return "sort";
		},
	},
);
check(
	"localeCompare coercion order and roots",
	localeCompareResult === 0 &&
		localeCompareOrder.join(",") === "receiver,that,locales,options",
);
check("DateTimeFormat present", typeof Intl.DateTimeFormat === "function");
const cachedDateFormat = new Intl.DateTimeFormat("de-DE", {
	dateStyle: "long",
	timeStyle: "short",
});
const cachedDateFormatFunction = cachedDateFormat.format;
const cachedDateValue = cachedDateFormatFunction(1_700_000_000_000);
check(
	"DateTimeFormat persistent native plan",
	cachedDateFormatFunction === cachedDateFormat.format &&
		cachedDateValue.length > 8 &&
		cachedDateFormatFunction(1_700_000_000_000) === cachedDateValue,
);
const mutableDateOptions = cachedDateFormat.resolvedOptions();
mutableDateOptions.dateStyle = "short";
check(
	"DateTimeFormat resolvedOptions copy does not alter plan",
	cachedDateFormatFunction(1_700_000_000_000) === cachedDateValue &&
		cachedDateFormat.resolvedOptions().dateStyle === "long",
);
let formatterLifecycleChecksum = 0;
for (let index = 0; index < 24; index++) {
	formatterLifecycleChecksum += new Intl.NumberFormat(index & 1 ? "de-DE" : "en-US", {
		maximumFractionDigits: 2,
	}).format(index + 0.25).length;
	formatterLifecycleChecksum += new Intl.DateTimeFormat(index & 1 ? "de-DE" : "en-US", {
		dateStyle: index & 1 ? "long" : "short",
	}).format(1_700_000_000_000 + index).length;
}
check("Intl formatter handle lifecycle", formatterLifecycleChecksum > 100);
check("PluralRules select", new Intl.PluralRules("en").select(1) === "one");
check("ListFormat present", typeof Intl.ListFormat === "function");

// Non-namespace methods of selected services still localize.
check("Number.toLocaleString localized", (1234.5).toLocaleString("de-DE") === "1.234,5");

// Dropped services are absent.
check("Segmenter dropped", typeof Intl.Segmenter === "undefined");
check("DisplayNames dropped", typeof Intl.DisplayNames === "undefined");
check("RelativeTimeFormat dropped", typeof Intl.RelativeTimeFormat === "undefined");
check("DurationFormat dropped", typeof Intl.DurationFormat === "undefined");

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
