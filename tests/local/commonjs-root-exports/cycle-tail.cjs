const early = require("./cycle-head.cjs");
exports.sawHead = typeof early;
try {
	early(1);
	exports.threw = false;
} catch (error) {
	exports.threw = error instanceof TypeError;
}
exports.later = function later(value) {
	return require("./cycle-head.cjs")(value);
};
