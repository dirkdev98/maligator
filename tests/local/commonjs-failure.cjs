globalThis.commonJsFailureAttempts++;
exports.partial = true;
if (globalThis.commonJsFailureAttempts === 1) {
	throw new Error("first load fails");
}
module.exports = { attempt: globalThis.commonJsFailureAttempts };
