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
let checksum = 0;
for (let i = 0; i < 10; i++) {
	checksum += spread();
	checksum += spread(1, 2, 3);
	checksum += dynamic(target, 1, 2, 3);
	checksum += apply(1, 2, 3);
}
if (checksum !== 180) throw new Error("checksum");
console.log("rest-forwarding-mechanism PASS");
