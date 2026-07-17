let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

const tty = require("tty");
const canonical = require("node:tty");
check(tty === canonical, "bare/canonical identity");
check(typeof tty.isatty === "function", "isatty export");
check(tty.isatty(undefined) === false, "invalid descriptor");
check(tty.ReadStream.prototype.constructor === tty.ReadStream, "ReadStream prototype");
check(tty.WriteStream.prototype.constructor === tty.WriteStream, "WriteStream prototype");

console.log("RESULT " + passed + "/" + total);
