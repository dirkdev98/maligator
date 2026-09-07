function compare(a, b) {
	return a - b;
}
function detached(receiver) {
	return receiver.sort.call(receiver, compare);
}
const sort = Array.prototype.sort;
Object.defineProperty(sort, "call", {
	configurable: true,
	value(receiver, comparator) {
		globalThis.observedReceiver = receiver;
		return comparator(9, 2) + 100;
	},
});
const input = [3, 1, 2];
console.log(
	"outer-override",
	detached(input),
	globalThis.observedReceiver === input,
	input.join(","),
);
delete sort.call;
console.log("restored", detached(input).join(","));
Object.defineProperty(sort, "call", {
	configurable: true,
	value: 3,
});
try {
	detached([2, 1]);
} catch (error) {
	console.log("noncallable-outer", error.name);
}
delete sort.call;
