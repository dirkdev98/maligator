"use strict";

function read(key) {
	return arguments[key];
}

const key = 4096;
const previous = Object.getOwnPropertyDescriptor(Object.prototype, String(key));
let calls = 0;
try {
	Object.defineProperty(Object.prototype, String(key), {
		configurable: true,
		get() {
			calls++;
			return "inherited";
		},
	});
	console.log(read(0, "own"), read(1, "own"), read(key, "own"), calls);
} finally {
	if (previous) Object.defineProperty(Object.prototype, String(key), previous);
	else delete Object.prototype[key];
}
