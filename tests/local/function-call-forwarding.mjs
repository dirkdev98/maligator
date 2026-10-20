// Calls through Function.prototype.call forward to their receiver, keeping the builtin's
// receiver binding, its TypeError for a non-callable receiver and class-constructor checks.
function add(a, b) {
	return this.base + a + b;
}
const host = { base: 10 };
const log = [
	add.call(host, 1, 2),
	Math.max.call(null, 3, 9),
	Object.prototype.hasOwnProperty.call(host, "base"),
];
const call = Function.prototype.call;
log.push(call.call(add, host, 4, 5));
try {
	call.call(42);
} catch (error) {
	log.push(error.constructor.name);
}
function sloppy() {
	return typeof this;
}
log.push(sloppy.call(7), sloppy.call(undefined) === "object");
class K {}
try {
	K.call({});
} catch (error) {
	log.push(error.constructor.name);
}
const bound = add.bind(host, 100);
log.push(bound.call(null, 1));
console.log(log.join(","));
