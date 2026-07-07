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
check("NumberFormat localized", new Intl.NumberFormat("de-DE").format(1234.5) === "1.234,5");
check("Collator present", typeof Intl.Collator === "function");
check("localeCompare (collator)", "b".localeCompare("a") === 1);
check("DateTimeFormat present", typeof Intl.DateTimeFormat === "function");
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
