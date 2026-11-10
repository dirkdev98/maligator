function caller(value) {
	return middle(value);
}
function middle(value) {
	if (value === undefined) return;
	later(value);
}
function later(value) {
	if (value === true) throw new Error("later");
}
globalThis.result = caller(globalThis.input);
