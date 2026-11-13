function check(condition) {
	if (!condition) throw new Error("for-of body environment mismatch");
}

const saved = [];
function collect(values) {
	let outer = 40;
	const readOuter = () => outer;
	for (const item of values) {
		let value = item;
		saved.push(() => ++value);
		value += 10;
	}
	outer += 2;
	return readOuter();
}
const emptyCalls = 2000;
for (let i = 0; i < emptyCalls; i++) check(collect([]) === 42);
check(collect([1, 2]) === 42);
check(saved[0]() === 12 && saved[1]() === 13 && saved[0]() === 13);

const continued = [];
outer: for (const item of [1, 2, 3]) {
	let value = item;
	continued.push(() => value);
	for (const inner of [0, 1]) {
		if (inner === 0) continue;
		value += 10;
		continue outer;
	}
}
check(continued.map((read) => read()).join() === "11,12,13");

function leaveNestedLoop(mode) {
	const reads = [];
	outer: for (const item of [1, 2, 3]) {
		let value = item;
		reads.push(() => value);
		for (const inner of [0, 1]) {
			let innerValue = inner;
			reads.push(() => innerValue);
			value += 10;
			if (mode === "break") break outer;
			continue outer;
		}
	}
	return reads.map((read) => read()).join();
}
check(leaveNestedLoop("break") === "11,0");
check(leaveNestedLoop("continue") === "11,0,12,0,13,0");

let closed = 0;
function iterable(throwOnNext = false, nextValue = 3) {
	return {
		[Symbol.iterator]() {
			return {
				next() {
					if (throwOnNext) throw new Error("next");
					return { value: nextValue, done: false };
				},
				return() {
					closed++;
					return {};
				},
			};
		},
	};
}
for (const item of iterable()) {
	let value = item;
	saved.push(() => value);
	break;
}
check(closed === 1 && saved.at(-1)() === 3);
try {
	for (const item of iterable()) {
		let value = item;
		saved.push(() => value);
		throw new Error("body");
	}
} catch (error) {
	check(error.message === "body");
}
check(closed === 2 && saved.at(-1)() === 3);
try {
	for (const item of iterable(true)) {
		let value = item;
		saved.push(() => value);
	}
} catch (error) {
	check(error.message === "next");
}
check(closed === 2);

function failBinding() {
	throw new Error("binding");
}
try {
	for (const [item = failBinding()] of iterable(false, [undefined])) {
		let value = item;
		saved.push(() => value);
	}
} catch (error) {
	check(error.message === "binding");
}
check(closed === 3);

function finish() {
	for (const item of [3]) {
		let value = item;
		try {
			return () => value;
		} finally {
			value += 2;
		}
	}
}
check(finish()() === 5);

const heads = [];
for (let item of [1, 2]) heads.push(() => ++item);
check(heads[0]() === 2 && heads[1]() === 3 && heads[0]() === 3);

let tdz = false;
try {
	for (let item of eval("item")) {
		let value = item;
		saved.push(() => value);
	}
} catch (error) {
	tdz = error instanceof ReferenceError;
}
check(tdz);
console.log(`for-of-body-environment PASS emptyCalls=${emptyCalls}`);
