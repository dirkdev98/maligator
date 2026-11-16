const id = process.env.MAL_BUILTIN_ID;
const value = require(id);
console.log(
	JSON.stringify([
		typeof value,
		value === require(id),
		value === process.getBuiltinModule(id),
		value.test === value,
	]),
);
