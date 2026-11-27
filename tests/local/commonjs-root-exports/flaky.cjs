let calls = 0;
module.exports = function count() {
	return ++calls;
};
if (globalThis.flakyFailed === undefined) {
	globalThis.flakyFailed = true;
	globalThis.leakedCount = module.exports;
	throw new Error("first evaluation fails");
}
