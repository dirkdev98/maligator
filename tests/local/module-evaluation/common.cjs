globalThis.commonCount = (globalThis.commonCount ?? 0) + 1;
module.exports = function twice(value) {
	return value * 2;
};
module.exports.named = 12;
