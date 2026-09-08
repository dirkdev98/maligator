function show(value) {
	console.log(Object.is(value, -0) ? "-0" : String(value));
}
let events = "";
show(Math.sumPrecise([1e20, 1, -1e20]));
show(Math.sumPrecise([]));
show(Math.sumPrecise([-0, -0]));
events = "";
const sumIterable = {
	[Symbol.iterator]() {
		events += "i";
		return {
			next() {
				events += "n";
				return { value: "1", done: false };
			},
			return() {
				events += "r";
				return {};
			},
		};
	},
};
try {
	Math.sumPrecise(sumIterable);
} catch (error) {
	show(error.name);
}
show(events);
for (const [action, message] of [
	[() => Math.sumPrecise(1), "Value is not iterable"],
	[() => Math.sumPrecise(), "Cannot read properties of null or undefined"],
]) {
	let first;
	try {
		action();
	} catch (error) {
		first = error;
	}
	if (first?.name !== "TypeError" || first.message !== message)
		throw new Error("Sum input validation changed");
	try {
		action();
	} catch (error) {
		if (first === error) throw new Error("Sum error identity was reused");
	}
}
