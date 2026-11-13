// Direct evals that read and write the bindings their scopes hold.
import { triple } from "./hot.mjs";

let moduleCounter = 0;
export let shared = "start";
// Imported bindings are not marshaled to a direct eval, so a local alias hands it over.
const tripled = triple;

function numeric(value) {
	return value * 2 + 1;
}

export function readWriteLocals(code) {
	let local = 1;
	const items = [1, 2, 3];
	const result = eval(code);
	return [local, items.length, result];
}

export function bumpModule(step) {
	return eval("moduleCounter += step");
}

export function rebindShared(value) {
	eval("shared = value");
}

export function oddArguments() {
	let total = 0;
	for (let index = 0; index < 200; index++) total += numeric(index) + tripled(index);
	return [
		total,
		eval("numeric('x')"),
		eval("numeric(1, 2, 3)"),
		eval("tripled('ab')"),
		eval("tripled([7])"),
	];
}

export function strictVar() {
	return [eval("var fresh = 1; fresh + 1"), typeof fresh];
}

export function* evalSequence(seed) {
	let state = seed;
	yield eval("state");
	state += 10;
	yield eval("state++");
	yield state;
}

export function restSeen(...values) {
	eval("values.push(values.length * 10)");
	let total = 0;
	for (const value of values) total += value;
	return total;
}

// Module-level, so every eval here can call it, but no eval sees its rest array.
export function restUnseen(...values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

export function capturedSeen(values, code) {
	const head = () => values[0];
	const tail = () => values[values.length - 1];
	const seen = eval(code);
	if (!values) return 0;
	return [head() + tail(), seen];
}

export function makeCounter() {
	let captured = 0;
	return {
		add(step) {
			captured += step;
			return captured;
		},
		peek: () => eval("captured"),
		poke: (code) => eval(code),
	};
}

export class Vault {
	#secret = 3;
	#log = [];
	read() {
		return eval("this.#secret");
	}
	write(value) {
		eval("this.#secret = value; this.#log.push(value)");
	}
	secretTotal() {
		let total = 0;
		for (let index = 0; index < 10; index++) total += this.#secret + 1;
		return total;
	}
	logTotal() {
		let total = 0;
		for (let index = 0; index < this.#log.length; index++) total += this.#log[index];
		return total;
	}
}

export function Point(x) {
	this.x = x + 1;
	if (x === 0) Point.escaped = [eval("new.target"), eval("this")];
}

class Base {
	greet(name) {
		return "base:" + name;
	}
}

export class Derived extends Base {
	constructor(tag) {
		super();
		this.tag = eval("new.target === Derived ? tag : 'other'");
	}
	greet(name) {
		return eval("super.greet(name + '!')");
	}
}
