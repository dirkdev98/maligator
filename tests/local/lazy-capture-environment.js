// Functions whose captured bindings only reach a closure on some paths.

const lines = [];

function createLogger(namespace, enabled) {
	function log(...args) {
		if (!log.enabled) return 0;
		let index = 0;
		const text = String(args[0]).replace(/%([a-z%])/g, (match, format) => {
			if (match === "%%") return "%";
			index++;
			return format === "u" ? String(args[index]).toUpperCase() : String(args[index]);
		});
		lines.push(`${namespace} ${text} ${index}`);
		return index;
	}
	log.enabled = enabled;
	return log;
}
const quiet = createLogger("quiet", false);
const loud = createLogger("loud", true);
let skipped = 0;
for (let round = 0; round < 2000; round++)
	skipped += quiet("%s %u", round, "x") === 0 ? 1 : 0;
loud("%s and %u %%", "first", "second");
lines.push(`skipped ${skipped}`);

function accumulate(values, limit) {
	let total = 0;
	const readers = [];
	for (const value of values) {
		total += value;
		if (total > limit) readers.push(() => total);
	}
	return `${readers.map((read) => read()).join(",")} ${total}`;
}
lines.push(accumulate([1, 2, 3, 4], 2), accumulate([1, 2], 10));

function guarded(flag) {
	let state = "initial";
	try {
		if (flag === 1) throw new Error("before");
		const read = () => state;
		state = "created";
		if (flag === 2) throw new Error("after");
		return read();
	} catch (error) {
		state += ` caught ${error.message}`;
		return state;
	}
}
lines.push(guarded(0), guarded(1), guarded(2));

function early(flag) {
	if (flag) return "skipped";
	const peek = () => value;
	let result;
	try {
		result = peek();
	} catch (error) {
		result = error.name;
	}
	let value = "ready";
	return `${result} ${peek()}`;
}
lines.push(early(true), early(false));

function depth(n) {
	const label = `d${n}`;
	if (n === 0) return label;
	const inner = depth(n - 1);
	const show = () => `${label}>${inner}`;
	return show();
}
lines.push(depth(6));

function makeCounter(flag) {
	if (!flag) return 0;
	class Counter {
		#count = 0;
		increment() {
			return ++this.#count;
		}
	}
	const counter = new Counter();
	counter.increment();
	return counter.increment();
}
lines.push(`counter ${makeCounter(false)} ${makeCounter(true)}`);

function doubled(value, wrap) {
	value = value * 2;
	if (!wrap) return value;
	const get = () => value;
	value += 1;
	return get();
}
lines.push(`doubled ${doubled(4, false)} ${doubled(4, true)}`);

function strictArguments(first) {
	"use strict";
	if (first === undefined) return `count ${arguments.length}`;
	const read = () => first;
	return `${arguments.length} ${read()}`;
}
lines.push(strictArguments(), strictArguments("one", 2));

function retained(size, keep) {
	const parts = [];
	for (let index = 0; index < size; index++) parts.push({ index, text: `part ${index}` });
	let joined = "";
	for (const part of parts) joined += part.text.length;
	if (!keep) return joined.length;
	const read = () => parts.map((part) => part.text).join("|").length + joined.length;
	return read();
}
lines.push(`retained ${retained(200, false)} ${retained(200, true)}`);

function joined(flag) {
	let note = "start";
	let reader = null;
	if (flag) {
		reader = () => note;
		note = "branch";
	}
	note += " joined";
	return reader === null ? note : `${note} ${reader()}`;
}
lines.push(joined(false), joined(true));

console.log(lines.join("\n"));
