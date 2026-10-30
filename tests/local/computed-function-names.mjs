function observe(fn) {
	const descriptor = Object.getOwnPropertyDescriptor(fn, "name");
	let checksum = 0;
	for (let index = 0; index < fn.name.length; index++)
		checksum = (checksum * 31 + fn.name.charCodeAt(index)) >>> 0;
	return [
		fn.name.length,
		fn.name.slice(0, 24),
		checksum,
		descriptor.writable,
		descriptor.enumerable,
		descriptor.configurable,
	];
}

function knownNames() {
	const missing = Symbol();
	const empty = Symbol("");
	const named = Symbol("named");
	const methods = {
		[Symbol.iterator]() {},
		[missing]() {},
		[empty]() {},
		[named]() {},
		get [Symbol.toStringTag]() {
			return "value";
		},
		set [Symbol.toStringTag](value) {},
	};
	const descriptor = Object.getOwnPropertyDescriptor(methods, Symbol.toStringTag);
	return [
		observe(methods[Symbol.iterator]),
		observe(methods[missing]),
		observe(methods[empty]),
		observe(methods[named]),
		observe(descriptor.get),
		observe(descriptor.set),
		Object.getOwnPropertySymbols(methods).includes(named),
	];
}
console.log(JSON.stringify(knownNames()));

for (const key of [
	Symbol.iterator,
	Symbol(),
	Symbol(""),
	Symbol("small"),
	Symbol("é".repeat(16)),
	Symbol("é".repeat(17)),
	Symbol("文".repeat(16)),
	Symbol("🐊".repeat(8)),
	Symbol("\ud800"),
	Symbol("long".repeat(8_192)),
	"string",
	17,
]) {
	const method = { [key]() {} };
	const accessor = {
		get [key]() {
			return 1;
		},
		set [key](value) {},
	};
	const descriptor = Object.getOwnPropertyDescriptor(accessor, key);
	console.log(
		JSON.stringify([
			observe(method[key]),
			observe(descriptor.get),
			observe(descriptor.set),
		]),
	);
}
