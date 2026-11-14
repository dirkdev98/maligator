const events = [];
async function resolved(value) {
	events.push(`body ${value}`);
	const result = await Promise.resolve(value);
	events.push(`resumed ${result}`);
	return result;
}
console.log("primitive", await resolved(11));

const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor");
Object.defineProperty(Promise.prototype, "constructor", {
	configurable: true,
	get() {
		events.push("constructor getter");
		return Promise;
	},
});
const observed = resolved(13);
queueMicrotask(() => events.push("constructor queued"));
console.log("constructor", await observed);
Object.defineProperty(Promise.prototype, "constructor", descriptor);

const originalResolve = Promise.resolve;
Promise.resolve = function (value) {
	events.push(`custom resolve ${value}`);
	return {
		then(resolve) {
			events.push("custom then");
			resolve(value + 1);
		},
	};
};
console.log("replacement", await resolved(17));
Promise.resolve = originalResolve;

class OtherPromise extends Promise {}
const other = originalResolve.call(OtherPromise, 19);
console.log("subclass", await (async () => await other)());
console.log(events.join("\n"));
