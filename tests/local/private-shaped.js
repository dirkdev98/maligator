function check(label, condition) {
	if (!condition) throw new Error(label);
}

class State {
	before = 1;
	#value = 2;
	after = 3;

	read() {
		return this.before + this.#value + this.after;
	}

	write(value) {
		this.#value = value;
	}
}

const states = [];
for (let i = 0; i < 1000; i++) states.push(new State());
for (let iteration = 0; iteration < 20; iteration++) {
	for (let i = 0; i < states.length; i++) {
		states[i].before = i;
		states[i].after = iteration;
		states[i].write(i + iteration);
		check("public and private loads", states[i].read() === i * 2 + iteration * 2);
	}
}

const reflected = states[0];
check("private names stay hidden", Object.keys(reflected).join(",") === "before,after");
check(
	"private names stay out of spread",
	JSON.stringify({ ...reflected }) === '{"before":0,"after":19}',
);

const prevented = new State();
Object.preventExtensions(prevented);
prevented.before = 10;
prevented.write(20);
check(
	"preventExtensions leaves existing public and private fields writable",
	prevented.read() === 33 && !Object.isExtensible(prevented),
);

const sealed = new State();
Object.seal(sealed);
sealed.before = 10;
sealed.write(20);
check("seal preserves private writes", sealed.read() === 33 && Object.isSealed(sealed));

const frozen = new State();
Object.freeze(frozen);
frozen.write(20);
check("freeze preserves private writes", frozen.read() === 24 && Object.isFrozen(frozen));

class ReturnReceiver {
	constructor(receiver) {
		return receiver;
	}
}
class Stamp extends ReturnReceiver {
	#value = 23;

	static read(receiver) {
		return receiver.#value;
	}
}
const frozenReceiver = Object.freeze({ public: 1 });
new Stamp(frozenReceiver);
check(
	"private fields can stamp a frozen shaped receiver",
	Stamp.read(frozenReceiver) === 23 && Object.keys(frozenReceiver)[0] === "public",
);

const publicSymbol = Symbol("public");
const symbolized = new State();
symbolized[publicSymbol] = 4;
symbolized.write(5);
check(
	"public symbol transition preserves both storage families",
	symbolized.read() === 9 &&
		symbolized[publicSymbol] === 4 &&
		Object.getOwnPropertySymbols(symbolized)[0] === publicSymbol,
);

const indexed = new State();
indexed[0] = 7;
indexed.write(8);
check(
	"index transition preserves private state",
	indexed.read() === 12 && indexed[0] === 7,
);

const redefined = new State();
Object.defineProperty(redefined, "before", { value: 9, enumerable: false });
redefined.write(10);
check(
	"descriptor transition preserves private state",
	redefined.read() === 22 && Object.keys(redefined).join(",") === "after",
);

const deleted = new State();
delete deleted.before;
deleted.write(11);
check(
	"delete transition preserves private state",
	Number.isNaN(deleted.read()) && deleted.after === 3,
);

class PrivateArray extends Array {
	#value = 12;

	read() {
		return this.#value;
	}
}
const array = new PrivateArray(1, 2, 3);
array.push(4);
check(
	"dense array storage coexists with private names",
	array.read() === 12 && array.join(",") === "1,2,3,4",
);

class PrivateReference extends ReturnReceiver {
	#columns = [11, 13];
	#other = [17];

	static same(receiver) {
		const first = receiver.#columns;
		const second = receiver.#columns;
		const third = receiver.#columns;
		return first === second && second === third;
	}

	static distinguish(left, right) {
		const first = left.#columns;
		return first !== right.#columns && first !== left.#other;
	}

	static replace(receiver, replacement) {
		const first = receiver.#columns;
		receiver.#columns = replacement;
		return first !== receiver.#columns && receiver.#columns === replacement;
	}

	static around(receiver, callback) {
		const first = receiver.#columns;
		callback();
		const second = receiver.#columns;
		return first !== second;
	}

	static retry(receiver, stamp) {
		let failures = 0;
		try {
			receiver.#columns;
		} catch {
			failures++;
			stamp();
		}
		const first = receiver.#columns;
		const second = receiver.#columns;
		return failures === 1 && first === second && second[0] === 11;
	}

	get value() {
		this.#columns = [29];
		return 0;
	}

	readAcrossGetter() {
		const first = this.#columns;
		this.value;
		return first !== this.#columns && this.#columns[0] === 29;
	}

	get #changing() {
		this.#columns = [this.#columns[0] + 1];
		return this.#columns;
	}

	readPrivateGetter() {
		const first = this.#changing;
		const second = this.#changing;
		return first !== second && second[0] === first[0] + 1;
	}
}

const reference = new PrivateReference();
check(
	"successful private loads retain their reference",
	PrivateReference.same(reference),
);
check(
	"private load identity includes receiver and name",
	PrivateReference.distinguish(reference, new PrivateReference()),
);
check(
	"private stores invalidate the reference",
	PrivateReference.replace(reference, [19]),
);
check(
	"callbacks may replace the private backing object",
	PrivateReference.around(reference, () => PrivateReference.replace(reference, [23])),
);
check("ordinary getters may replace private state", reference.readAcrossGetter());
check("private getters execute every time", reference.readPrivateGetter());
const unstamped = {};
check(
	"failed private loads cannot supply a successful retry",
	PrivateReference.retry(unstamped, () => new PrivateReference(unstamped)),
);
let privateProxyTraps = 0;
const privateProxy = new Proxy(reference, {
	get() {
		privateProxyTraps++;
		return undefined;
	},
});
let privateProxyThrew = false;
try {
	PrivateReference.same(privateProxy);
} catch (error) {
	privateProxyThrew = error instanceof TypeError;
}
check(
	"private loads reject an unbranded proxy without traps",
	privateProxyThrew && privateProxyTraps === 0,
);

console.log("private-shaped PASS");
