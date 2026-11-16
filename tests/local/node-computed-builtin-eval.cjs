const load = eval("require");
const id = process.argv[2];
const first = load(id);
console.log(
	JSON.stringify([
		typeof first,
		first === load(id),
		first === process.getBuiltinModule(id),
	]),
);
