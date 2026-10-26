function caller(value) {
	return middle(value);
}
function middle(value) {
	return later(value);
}
function later(value) {
	return value + 1;
}
globalThis.result = caller(globalThis.input);
