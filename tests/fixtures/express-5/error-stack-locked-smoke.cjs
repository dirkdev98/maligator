"use strict";

/* oxlint-disable -- This compatibility fixture intentionally runs pinned CommonJS packages. */

const prepareDescriptor = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
const limitDescriptor = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
if (
	!Object.isFrozen(Error) ||
	prepareDescriptor === undefined ||
	typeof prepareDescriptor.get !== "function" ||
	typeof prepareDescriptor.set !== "function" ||
	prepareDescriptor.configurable !== false ||
	limitDescriptor === undefined ||
	typeof limitDescriptor.get !== "function" ||
	typeof limitDescriptor.set !== "function" ||
	limitDescriptor.configurable !== false
) {
	throw new Error("locked Node Error hooks are not physically frozen accessors");
}

Error.prepareStackTrace = undefined;
Error.stackTraceLimit = 10;
const prepareStackTrace = Error.prepareStackTrace;
const stackTraceLimit = Error.stackTraceLimit;

require("./error-stack-smoke.cjs");

if (
	Error.prepareStackTrace !== prepareStackTrace ||
	Error.stackTraceLimit !== stackTraceLimit
) {
	throw new Error("Node Error stack hooks were not restored after dependency load");
}
