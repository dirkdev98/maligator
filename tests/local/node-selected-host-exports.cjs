const net = require("node:net");
const { isIP } = require("node:net");
const os = require("node:os");
const path = require("node:path");
const url = require("node:url");
const util = require("node:util");

console.log(isIP === net.isIP, isIP("2001:db8::7"), net.isIPv4("127.0.0.1"));
console.log(os.release(), path.basename(path.join("/fixtures", "reports")));
const parsed = url.parse("https://example.org:8080/docs");
console.log(parsed.constructor === url.Url, parsed.format());
const reports = {
	[Symbol.for("nodejs.util.inspect.custom")](_depth, _options, inspect) {
		return typeof inspect;
	},
};
console.log(
	util.formatWithOptions({ colors: false }, "%s:%d", "reports", 3),
	util.formatWithOptions({ colors: false }, reports),
);
