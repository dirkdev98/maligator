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

console.log("private-shaped PASS");
