// Calls through Function.prototype.call and apply forward to their receiver, keeping the
// builtins' receiver binding, list creation, TypeErrors and class-constructor checks.
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
function count() {
	return `${arguments.length}:${Array.prototype.join.call(arguments, "|")}`;
}
function forward() {
	return add.apply(this, arguments);
}
const allocating = {
	length: 3,
	get 0() {
		return { value: "a" }.value;
	},
	1: "b",
	get 2() {
		return ["c", "d"].join("");
	},
};
log.push(
	add.apply(host, [1, 2]),
	forward.call(host, 3, 4),
	count.apply(null),
	count.apply(null, null),
	count.apply(null, allocating),
	count.apply(null, [1, , 3]),
	count.apply(
		null,
		Array.from({ length: 20 }, (_, index) => index),
	),
	Math.max.apply(null, [3, 9, 4]),
	sloppy.apply(7, []),
	bound.apply(null, [2]),
);
for (const attempt of [
	() => add.apply(host, 5),
	() => Function.prototype.apply.call(42),
	() => K.apply({}),
]) {
	try {
		attempt();
	} catch (error) {
		log.push(error.constructor.name);
	}
}
console.log(log.join(","));
