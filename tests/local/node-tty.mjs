import tty, { ReadStream, WriteStream, isatty } from "node:tty";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

check(tty.isatty === isatty, "default/named isatty identity");
check(tty.ReadStream === ReadStream, "default/named ReadStream identity");
check(tty.WriteStream === WriteStream, "default/named WriteStream identity");
check(isatty() === false, "missing descriptor");
check(isatty("1") === false, "descriptor type validation");
check(isatty(-1) === false, "negative descriptor");
check(isatty(999999) === false, "closed descriptor");
check(typeof ReadStream === "function", "ReadStream constructor");
check(typeof ReadStream.prototype.setRawMode === "function", "raw mode method");
check(typeof WriteStream === "function", "WriteStream constructor");
check(
	typeof WriteStream.prototype.getColorDepth === "function" &&
		typeof WriteStream.prototype.hasColors === "function" &&
		typeof WriteStream.prototype.getWindowSize === "function",
	"WriteStream terminal methods",
);

let invalidDescriptor = false;
try {
	new WriteStream(-1);
} catch (error) {
	invalidDescriptor = error instanceof RangeError;
}
check(invalidDescriptor, "constructor descriptor validation");

let nonTerminal = false;
try {
	new WriteStream(999999);
} catch (error) {
	nonTerminal = error instanceof Error;
}
check(nonTerminal, "constructor rejects non-terminal descriptor");

console.log("RESULT " + passed + "/" + total);
