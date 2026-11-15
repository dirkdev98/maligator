function target(a = 0, b = 0, c = 0) {
	return a + b + c;
}
function spread(...args) {
	return target(...args);
}
function dynamic(fn, ...args) {
	return fn(...args);
}
function apply(...args) {
	return target.apply(null, args);
}
function prefix(first, ...args) {
	return target(first, ...args);
}
function repeated(fn, first, ...args) {
	let result = 0;
	for (let i = 0; i < 2; i++) result += fn(first, ...args);
	return result;
}
let checksum = 0;
for (let i = 0; i < 10; i++) {
	checksum += spread();
	checksum += spread(1, 2, 3);
	checksum += dynamic(target, 1, 2, 3);
	checksum += apply(1, 2, 3);
	checksum += prefix(1, 2, 3);
	checksum += repeated(target, 1, 2, 3);
}
if (checksum !== 360) throw new Error("checksum");
class ConstructorFirst {
	constructor(...args) {
		this.value = target(...args);
	}
}
class ConstructorSecond {
	constructor(first, ...args) {
		this.value = target(first, ...args);
	}
}
let constructorChecksum = 0;
for (let i = 0; i < 10; i++) {
	const Constructor = i & 1 ? ConstructorFirst : ConstructorSecond;
	constructorChecksum += new Constructor(1, 2, 3).value;
}
if (constructorChecksum !== 60) throw new Error("constructor checksum");
console.log("rest-forwarding-mechanism PASS");
