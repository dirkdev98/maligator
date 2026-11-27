// Looking globals up by a computed name hides which globals the program reads,
// so the build keeps every host installer.
function available(name) {
	return typeof globalThis[name] === "function";
}

console.log(available("setTimeout"), available("queueMicrotask"));
