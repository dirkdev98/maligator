// An owner reads its own captured bindings as plain values only while no closure,
// arguments object or later store can change them between the store and the read.
const results = [];
const attempt = (label, run) => {
	try {
		results.push([label, run()]);
	} catch (error) {
		results.push([label, error.constructor.name]);
	}
};

function scaleAll(items, factor) {
	function scale(value) {
		return value * factor;
	}
	let sum = 0;
	for (let i = 0; i < items.length; i++) sum += scale(items[i]);
	return sum;
}
const items = Array.from({ length: 64 }, (_, i) => i * 0.25);
for (let round = 0; round < 50; round++) scaleAll(items, round);
results.push(["scale", scaleAll(items, 1.5)]);

function loopUpdates(n) {
	let total = 0;
	const read = () => total;
	const seen = [];
	for (let i = 0; i < n; i++) {
		seen.push(read());
		total += i;
	}
	return [seen, read()];
}
results.push(["loop", loopUpdates(5)]);

function counter(n) {
	let i = 0;
	const get = () => i;
	let out = 0;
	while (get() < n) {
		out += get();
		i++;
	}
	return out;
}
results.push(["counter", counter(10)]);

function conditional(flag) {
	let value = 1;
	const read = () => value;
	if (flag) value = 2;
	return read();
}
results.push(["conditional", conditional(true), conditional(false)]);

function branches(flag) {
	let mode = "none";
	const read = () => mode;
	if (flag) {
		mode = "yes";
		return read();
	}
	mode = "no";
	return read();
}
results.push(["branches", branches(true), branches(false)]);

function partial(step) {
	let stage = 0;
	const read = () => stage;
	try {
		stage = 1;
		step();
		stage = 2;
	} catch {
		return ["caught", read()];
	}
	return ["done", read()];
}
results.push([
	"partial",
	partial(() => {
		throw new Error("stop");
	}),
	partial(() => {}),
]);

function writer() {
	let count = 0;
	const bump = () => {
		count++;
	};
	const read = () => count;
	bump();
	bump();
	return read();
}
results.push(["writer", writer()]);

function escaping(register) {
	let value = "before";
	register(() => {
		value = "after";
	});
	return value;
}
results.push(["escaping", escaping((set) => set()), escaping(() => {})]);

function mapped(a) {
	const read = () => a;
	arguments[0] = "changed";
	return read();
}
results.push(["mapped", mapped("original")]);

function recurse(depth) {
	const label = "d" + depth;
	const read = () => label;
	const inner = depth > 0 ? recurse(depth - 1) : "";
	return read() + inner;
}
results.push(["recurse", recurse(3)]);

function tdz(early) {
	const read = () => late;
	if (early) return read();
	const late = 3;
	return read();
}
attempt("tdz-early", () => tdz(true));
attempt("tdz-late", () => tdz(false));

function* staged() {
	let x = 1;
	const read = () => x;
	yield read();
	x = 2;
	yield read();
}
results.push(["generator", [...staged()]]);

function boxed() {
	class Box {
		#value = 1;
		get() {
			return this.#value;
		}
	}
	return new Box().get();
}
results.push(["private", boxed()]);

function perIteration() {
	const readers = [];
	for (let i = 0; i < 3; i++) readers.push(() => i);
	return readers.map((read) => read());
}
results.push(["per-iteration", perIteration()]);

console.log(JSON.stringify(results));
