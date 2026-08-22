from pathlib import Path

path = Path("tests/local/number-methods.js")
source = path.read_text()
marker = 'console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);\n'
assert source.count(marker) == 1
addition = '''const defaultLocaleFirst = (1234.5).toLocaleString();
const defaultLocaleSecond = (1234.5).toLocaleString(undefined, undefined);
check(
	"toLocaleString reuses default semantics",
	defaultLocaleFirst === defaultLocaleSecond && typeof defaultLocaleFirst === "string",
);
let useGroupingReads = 0;
const localeOptions = {
	get useGrouping() {
		useGroupingReads++;
		return false;
	},
};
(1234.5).toLocaleString(undefined, localeOptions);
(1234.5).toLocaleString(undefined, localeOptions);
check(
	"toLocaleString custom options remain observable",
	useGroupingReads === 2,
);

'''
path.write_text(source.replace(marker, addition + marker))
