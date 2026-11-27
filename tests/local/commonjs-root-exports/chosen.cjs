if (globalThis.chooseSecond === undefined) module.exports = first;
else module.exports = second;
function first(value) {
	return `first:${value}`;
}
function second(value) {
	return `second:${value}`;
}
