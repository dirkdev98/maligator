exports.add = function (a, b) {
	return a + b;
};
exports.scale = function (value) {
	return value * this.factor;
};
exports.factor = 3;
