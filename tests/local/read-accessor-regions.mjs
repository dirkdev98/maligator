function check(condition, message) {
	if (!condition) throw new Error(message);
}

class Kernel {
	#columns;
	constructor(columns) {
		this.#columns = columns;
	}
	start(index) {
		return this.#columns.starts[index] ?? 0;
	}
	count(index) {
		return this.#columns.counts[index] ?? 0;
	}
	operand(index) {
		return this.#columns.operands[index];
	}
	retire() {
		this.#columns = new Proxy(
			{},
			{
				get() {
					throw new Error("retired");
				},
			},
		);
	}
	replace(columns) {
		this.#columns = columns;
	}
}

function readPair(kernel, index) {
	const first = kernel.start(index);
	const second = kernel.start(index);
	return [first, second];
}

function readSingle(kernel, index) {
	return kernel.start(index);
}
globalThis.singleRead = readSingle;

function scan(kernel, length) {
	let total = 0;
	for (let instruction = 0; instruction < length; instruction++) {
		const start = kernel.start(instruction);
		const count = kernel.count(instruction);
		for (let offset = 0; offset < count; offset++)
			total += kernel.operand(start + offset);
	}
	return total;
}

const kernel = new Kernel({ starts: [0, 2], counts: [2, 1], operands: [3, 5, 7] });
for (let round = 0; round < 100; round++) check(scan(kernel, 2) === 15, "column chain");
check(readPair(kernel, 0).join() === "0,0", "shared read");
check(scan(null, 0) === 0, "empty loop does not access receiver");
check(kernel.count(99) === 0, "out of bounds default");
const sparse = [, null, undefined, -0];
kernel.replace({ starts: sparse, counts: [1, 1, 1, 1], operands: [1] });
check(readPair(kernel, 0).join() === "0,0", "holes");
check(readPair(kernel, 1).join() === "0,0", "null default");
check(readPair(kernel, 2).join() === "0,0", "undefined default");
check(Object.is(readPair(kernel, 3)[0], -0), "negative zero");

let reads = 0;
kernel.replace({
	get starts() {
		reads++;
		return [reads];
	},
});
check(
	readPair(kernel, 0).join() === "1,2" && reads === 2,
	"named getters execute once per access",
);
const elements = [];
Object.defineProperty(elements, "0", {
	get() {
		return ++reads;
	},
});
kernel.replace({ starts: elements });
check(readPair(kernel, 0).join() === "3,4", "indexed getters");

const log = [];
const receiver = new Proxy(kernel, {
	get(target, key) {
		log.push(key);
		return target[key];
	},
});
let threw = false;
try {
	readPair(receiver, 0);
} catch (error) {
	threw = error instanceof TypeError;
}
check(threw && log.join() === "start", "proxy method lookup precedes brand failure");
try {
	readPair({}, 0);
} catch (error) {
	check(error instanceof TypeError, "missing method error");
}

kernel.start = function (index) {
	return index + 20;
};
check(readPair(kernel, 2).join() === "22,22", "own override");
delete kernel.start;
const saved = Kernel.prototype.start;
Kernel.prototype.start = function () {
	return 42;
};
check(readPair(kernel, 0).join() === "42,42", "prototype override");
Kernel.prototype.start = saved;

const mutable = { starts: [8], counts: [1], operands: [1] };
kernel.replace(mutable);
check(readPair(kernel, 0).join() === "8,8", "initial references");
mutable.starts = [9];
check(readPair(kernel, 0).join() === "9,9", "named reference replacement");
const inherited = { starts: [13] };
const inheritedColumns = Object.create(inherited);
kernel.replace(inheritedColumns);
for (let round = 0; round < 20; round++)
	check(readPair(kernel, 0).join() === "13,13", "inherited column reference");
inherited.starts = [14];
check(readPair(kernel, 0).join() === "14,14", "inherited reference replacement");
inheritedColumns.starts = [15];
check(readPair(kernel, 0).join() === "15,15", "own column shadows cached prototype");
delete inheritedColumns.starts;
check(readPair(kernel, 0).join() === "14,14", "deleted column restores prototype");
Object.defineProperty(inherited, "starts", {
	get() {
		return [++reads];
	},
	configurable: true,
});
check(readPair(kernel, 0).join() === "5,6", "prototype getter replaces cached data");

let methodReads = 0;
Object.defineProperty(kernel, "start", {
	get() {
		methodReads++;
		return saved;
	},
	configurable: true,
});
kernel.replace({ starts: [16] });
check(
	readPair(kernel, 0).join() === "16,16" && methodReads === 2,
	"method getters retain original lookup order and frequency",
);
delete kernel.start;

function retireBetweenReads(value) {
	const first = value.start(0);
	value.retire();
	return first + value.start(0);
}
threw = false;
try {
	retireBetweenReads(kernel);
} catch (error) {
	threw = error.message === "retired";
}
check(threw, "retirement invalidates backing reference");

let argumentCalls = 0;
kernel.replace({ starts: [4] });
function argument() {
	argumentCalls++;
	return 0;
}
check(kernel.start(argument()) === 4 && argumentCalls === 1, "argument executes once");
let singleReads = 0;
const singleElements = [23];
Object.defineProperty(singleElements, "-1", {
	get() {
		singleReads++;
		return 31;
	},
});
const singleKernel = new Kernel({ starts: singleElements });
check(globalThis.singleRead(singleKernel, -1) === 31, "terminal named index getter");
check(singleReads === 1, "terminal getter executes once");
singleKernel.replace({ starts: [23] });
const changingIndex = {
	[Symbol.toPrimitive]() {
		singleKernel.replace({ starts: [47] });
		return "0";
	},
};
check(
	globalThis.singleRead(singleKernel, changingIndex) === 23,
	"index coercion uses resolved array",
);
check(globalThis.singleRead(singleKernel, 0) === 47, "later read sees changed columns");
const throwingIndex = {
	[Symbol.toPrimitive]() {
		throw new Error("terminal key");
	},
};
let terminalThrew = false;
try {
	globalThis.singleRead(singleKernel, throwingIndex);
} catch (error) {
	terminalThrew = error.message === "terminal key";
}
check(terminalThrew, "terminal key exception reaches caller");
console.log("read-accessor-regions PASS");
