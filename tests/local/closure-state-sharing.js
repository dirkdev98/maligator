function check(label, actual, expected) {
	if (actual !== expected) throw new Error(label + ": " + actual + " !== " + expected);
}

function makeFamily(initial) {
	let value = initial;
	const read = () => value;
	const write = (next) => (value = next);
	const nested = () => () => value;
	return { read, write, nested };
}
const left = makeFamily(1);
const right = makeFamily(10);
const deep = left.nested();
left.write(4);
check("siblings share one binding", left.read(), 4);
check("transitive capture", deep(), 4);
check("activations have distinct bindings", right.read(), 10);
right.write(12);
check("distinct setter", right.read(), 12);
check("no cross-activation alias", deep(), 4);

const iterations = [];
for (let i = 0; i < 4; i++) {
	let value = i * 10;
	iterations.push({ read: () => [i, value].join(":"), write: (next) => (value = next) });
}
iterations[1].write(99);
check(
	"per-iteration identities",
	iterations.map((entry) => entry.read()).join(","),
	"0:0,1:99,2:20,3:30",
);

function initializedLater() {
	const read = () => value;
	let early;
	try {
		read();
	} catch (error) {
		early = error instanceof ReferenceError;
	}
	const value = { answer: 42 };
	check("immutable capture preserves TDZ", early, true);
	return read;
}
check("immutable capture after initialization", initializedLater()().answer, 42);

function recursiveFamily() {
	let visits = 0;
	const even = (n) => {
		visits++;
		return n === 0 || odd(n - 1);
	};
	const odd = (n) => {
		visits++;
		return n !== 0 && even(n - 1);
	};
	return { even, read: () => visits };
}
const recursive = recursiveFamily();
check("mutual recursion", recursive.even(8), true);
check("recursive state sharing", recursive.read(), 9);

function reentrantFamily() {
	let value = { count: 1 };
	return {
		read: () => value.count,
		run(callback) {
			try {
				callback(() => (value = { count: 9 }));
			} finally {
				value.count++;
			}
		},
	};
}
const reentrant = reentrantFamily();
try {
	reentrant.run((replace) => {
		replace();
		throw new Error("expected");
	});
} catch (error) {
	check("exception crosses closure call", error.message, "expected");
}
check("reentry and finally observe current cell", reentrant.read(), 10);

function makeReader(value) {
	return () => value;
}
const readers = [makeReader(3), makeReader(7)];
let checksum = 0;
for (let i = 0; i < 100; i++) checksum += readers[i & 1]();
check("same code keeps distinct closure state", checksum, 500);

function makeCounter() {
	let value = 0;
	return {
		next: function* () {
			yield ++value;
			yield ++value;
		},
		read: () => value,
	};
}
const counter = makeCounter();
const a = counter.next();
const b = counter.next();
check("first suspended activation", a.next().value, 1);
check("second suspended activation", b.next().value, 2);
check("resumed shared cell", a.next().value, 3);
check("generator state remains shared", counter.read(), 3);

function Receiver(value) {
	this.value = value;
	this.read = () => this.value;
	this.target = () => new.target;
}
const receiver = new Receiver(23);
check("lexical this", receiver.read.call({ value: 99 }), 23);
check("lexical new.target", receiver.target(), Receiver);

// A closure's heap-valued state must survive allocation after its creator returns.
function retained(seed) {
	const state = { seed };
	let current = state;
	return { read: () => current.seed, replace: (next) => (current = { seed: next }) };
}
const retainedState = retained(31);
for (let i = 0; i < 2000; i++) {
	const temporary = retained(i);
	if (i === 1000) retainedState.replace(47);
	check("allocation pressure", temporary.read(), i);
}
check("escaped state survives collection", retainedState.read(), 47);
console.log("closure-state-sharing PASS");
