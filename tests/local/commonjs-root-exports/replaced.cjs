module.exports = original;
original.replace = function () {
	module.exports = replacement;
};
function original(value) {
	return `original:${value}`;
}
function replacement(value) {
	return `replacement:${value}`;
}
