const value = require("node:test");
console.log(
	JSON.stringify([
		typeof value,
		value === require("node:test"),
		value === process.getBuiltinModule("node:test"),
		value.test === value,
	]),
);
