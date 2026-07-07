// engine.intl:false fixture. Built with intlEnabled:false (no ICU crates, no Intl
// global). Asserts the Intl namespace is absent and the locale-sensitive methods
// outside it degrade to the documented locale-insensitive fallbacks. Date-format
// assertions match the shape (not an exact value) so they hold in any timezone.

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

check("typeof Intl === undefined", typeof Intl === "undefined");

// localeCompare → UTF-16 code-unit ordering.
check("localeCompare b>a", "b".localeCompare("a") === 1);
check("localeCompare a==a", "a".localeCompare("a") === 0);
check("localeCompare a<b", "a".localeCompare("b") === -1);

// Number.prototype.toLocaleString → base-10 Number::toString.
check("number toLocaleString", (1234.5).toLocaleString() === "1234.5");
check("negative number toLocaleString", (-42).toLocaleString() === "-42");

// Date.prototype.toLocale* → fixed non-localized shape (local civil components).
const d = new Date(1000000000000); // 2001-09-09T01:46:40Z
check("toLocaleDateString shape", /^\d{4}-\d{2}-\d{2}$/.test(d.toLocaleDateString()));
check("toLocaleTimeString shape", /^\d{2}:\d{2}:\d{2}$/.test(d.toLocaleTimeString()));
check(
	"toLocaleString shape",
	/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.toLocaleString()),
);
check("invalid date", new Date(NaN).toLocaleString() === "Invalid Date");

// toLocale{Upper,Lower}Case already alias the plain case methods.
check("toLocaleUpperCase", "abc".toLocaleUpperCase() === "ABC");
check("toLocaleLowerCase", "ABC".toLocaleLowerCase() === "abc");

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
