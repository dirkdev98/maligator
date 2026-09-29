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

function makeDeepFamily(seed) {
	let outer = { value: seed };
	return {
		write: (next) => (outer = { value: next }),
		middle: (offset) => () => () => outer.value + offset,
	};
}
const deepFamily = makeDeepFamily(30);
const delayedFactory = deepFamily.middle(2);
deepFamily.write(50);
const delayedReader = delayedFactory();
deepFamily.write(70);
check("intermediate closures forward ancestor cells", delayedReader(), 72);

function recursiveActivations(depth) {
	let value = depth;
	const nested = depth === 0 ? [] : recursiveActivations(depth - 1);
	nested.push({
		read: () => () => value,
		write: (next) => (value = next),
	});
	return nested;
}
const recursiveBindings = recursiveActivations(3);
const recursiveReaders = recursiveBindings.map((entry) => entry.read());
recursiveBindings[2].write(42);
check(
	"recursive owners retain their own activation",
	recursiveReaders.map((read) => read()).join(","),
	"0,1,42,3",
);

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

const iterationFactories = [];
for (let i = 0; i < 3; i++) {
	iterationFactories.push(() => ({
		read: () => i,
		write: (next) => (i = next),
	}));
}
const delayedIterations = iterationFactories.map((create) => create());
delayedIterations[1].write(8);
check(
	"descendants created after the loop share the original iteration cell",
	delayedIterations.map((entry) => entry.read()).join(","),
	"0,8,2",
);
check("separate descendants share the same iteration", iterationFactories[1]().read(), 8);

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

function* suspendedIterations() {
	for (let i = 0; i < 3; i++) {
		yield { read: () => i, write: (next) => (i = next) };
	}
}
const suspended = suspendedIterations();
const suspendedFirst = suspended.next().value;
const suspendedSecond = suspended.next().value;
suspendedFirst.write(20);
check("resumed loop copies into a new capture identity", suspendedSecond.read(), 1);
check("old suspended iteration stays mutable", suspendedFirst.read(), 20);
check("resumed loop keeps its current identity", suspended.next().value.read(), 2);

function capturedArguments(value) {
	return {
		read: () => [arguments[0].count, value.count].join(":"),
		replaceArgument: (next) => (arguments[0] = { count: next }),
		replaceParameter: (next) => (value = { count: next }),
	};
}
const argumentsFamily = capturedArguments({ count: 3 });
argumentsFamily.replaceArgument(5);
argumentsFamily.replaceParameter(7);
check(
	"lexical arguments and strict parameter cells stay distinct",
	argumentsFamily.read(),
	"5:7",
);

function capturedPrivateNames(seed) {
	return class Holder {
		#value = seed;
		family() {
			return {
				read: () => this.#value,
				write: (next) => (this.#value = next),
			};
		}
		static reader() {
			return (instance) => instance.#value;
		}
	};
}
const FirstHolder = capturedPrivateNames(13);
const SecondHolder = capturedPrivateNames(17);
const firstHolder = new FirstHolder();
const privateFamily = firstHolder.family();
privateFamily.write(19);
check(
	"private names and receiver survive nested closure creation",
	privateFamily.read(),
	19,
);
check("class constructor retains outer capture", new SecondHolder().family().read(), 17);
let rejectedPrivateBrand = false;
try {
	SecondHolder.reader()(firstHolder);
} catch (error) {
	rejectedPrivateBrand = error instanceof TypeError;
}
check(
	"separate class evaluations retain distinct private names",
	rejectedPrivateBrand,
	true,
);

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

function localProjection(seed) {
	let bias = seed;
	const project = (x) =>
		x * 1 +
		bias +
		(x * 2 + bias) +
		(x * 3 + bias) +
		(x * 4 + bias) +
		(x * 5 + bias) +
		(x * 6 + bias) +
		(x * 7 + bias) +
		(x * 8 + bias) +
		(x * 9 + bias) +
		(x * 10 + bias) +
		(x * 11 + bias) +
		(x * 12 + bias) +
		(x * 13 + bias) +
		(x * 14 + bias) +
		(x * 15 + bias) +
		(x * 16 + bias) +
		(x * 17 + bias) +
		(x * 18 + bias) +
		(x * 19 + bias) +
		(x * 20 + bias);
	let sum = 0;
	for (let i = 0; i < 32; i++) {
		bias = (bias + 1) | 0;
		sum += project(i);
	}
	return sum;
}
check(
	"local capture argument changes on every call",
	localProjection(5),
	210 * 496 + 20 * (32 * 5 + 528),
);

function localLateInitialization() {
	const project = (x) =>
		x * 1 +
		bias +
		(x * 2 + bias) +
		(x * 3 + bias) +
		(x * 4 + bias) +
		(x * 5 + bias) +
		(x * 6 + bias) +
		(x * 7 + bias) +
		(x * 8 + bias) +
		(x * 9 + bias) +
		(x * 10 + bias) +
		(x * 11 + bias) +
		(x * 12 + bias) +
		(x * 13 + bias) +
		(x * 14 + bias) +
		(x * 15 + bias) +
		(x * 16 + bias) +
		(x * 17 + bias) +
		(x * 18 + bias) +
		(x * 19 + bias) +
		(x * 20 + bias);
	let wasTdz = false;
	try {
		project(1);
	} catch (error) {
		wasTdz = error instanceof ReferenceError;
	}
	const bias = 9;
	check("local capture argument keeps TDZ", wasTdz, true);
	return project(2);
}
check("local capture argument after initialization", localLateInitialization(), 600);

function localHeapCapture() {
	let state = { count: 1 };
	const read = (x) => state.count + x;
	let sum = 0;
	for (let i = 0; i < 1000; i++) {
		state = { count: i };
		sum += read(i);
	}
	return sum;
}
check("local heap capture argument stays rooted", localHeapCapture(), 999000);

function siblingDuringRead() {
	let bias = 1;
	const update = (next) => (bias = next);
	const project = (x) => x.value + bias;
	return project({
		get value() {
			update(20);
			return 2;
		},
	});
}
check("reentrant sibling keeps live cell", siblingDuringRead(), 22);
console.log("closure-state-sharing PASS");
