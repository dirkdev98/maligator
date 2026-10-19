import constants from "node:constants";
import fs from "node:fs";
import os from "node:os";
import punycode from "node:punycode";
import sys from "node:sys";
import util from "node:util";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
show("constants", [
	Object.isFrozen(constants),
	constants.O_RDONLY === fs.constants.O_RDONLY,
	constants.SIGTERM === os.constants.signals.SIGTERM,
	constants.ENOENT === os.constants.errno.ENOENT,
	constants.RTLD_NOW === os.constants.dlopen.RTLD_NOW,
	constants.PRIORITY_HIGH,
	Object.keys(constants).indexOf("RTLD_LAZY"),
]);
show("sys", sys === util);
show("punycode", [punycode.version, Object.keys(punycode)]);
for (const value of ["mañana", "ü", "abc", "", "☃-⌘", "𝌆", "Bücher-straße"]) {
	show(`encode ${value}`, punycode.encode(value));
}
for (const value of ["maana-pta", "tda", "abc-", "--", "-> $1.00 <--"]) {
	show(`decode ${value}`, punycode.decode(value));
}
show(
	"toASCII",
	[
		"mañana.com",
		"user@mañana.com",
		"☃.net",
		"ascii.org",
		"a。b．c",
		"XN--MAANA-PTA.com",
	].map(punycode.toASCII),
);
show(
	"toUnicode",
	["xn--maana-pta.com", "user@xn--maana-pta.com", "XN--MAANA-PTA.com", "ascii.org"].map(
		punycode.toUnicode,
	),
);
show("ucs2", [punycode.ucs2.decode("𝌆a\ud800"), punycode.ucs2.encode([0x1d306, 97])]);
for (const run of [
	() => punycode.decode("é-a"),
	() => punycode.decode("a-!"),
	() => punycode.decode("99999999999"),
]) {
	try {
		run();
	} catch (error) {
		show("error", [error.name, error.message]);
	}
}
console.log(lines.join("\n"));
