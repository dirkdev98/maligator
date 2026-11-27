module.exports = double;
const seen = require("./exported-first-tail.cjs");
double.seen = seen;
function double(value) {
	return value * 2;
}
