class Kernel {
	#columns;
	constructor(items) {
		this.#columns = { items };
	}
	read(index) {
		return this.#columns.items[index] ?? 0;
	}
	_retireGeneration(items) {
		this.#columns = { items };
	}
	replaceElement(index, value) {
		this.#columns.items[index] = value;
	}
}

function materialize(owner, count, after) {
	const output = [];
	for (let index = 0; index < count; index++) {
		output.push(owner.kernel.read(index));
		if (after) after(index, owner);
	}
	return output;
}

globalThis.materialize = materialize;
const cases = [];
const input = () => Array.from({ length: 8 }, (_, index) => index);
for (const count of [0, 1, 2, 8, 32])
	cases.push(globalThis.materialize({ kernel: new Kernel(input()) }, count, null));

for (const kind of ["retire", "method", "receiver", "element"]) {
	const owner = { kernel: new Kernel(input()) };
	const observed = [];
	const values = globalThis.materialize(owner, 8, (index, receiver) => {
		observed.push(index);
		if (index !== 1) return;
		if (kind === "retire")
			receiver.kernel._retireGeneration(input().map((value) => value + 100));
		else if (kind === "method") receiver.kernel.read = (index) => index + 1000;
		else if (kind === "receiver")
			receiver.kernel = new Kernel(input().map((value) => value + 200));
		else receiver.kernel.replaceElement(2, 77);
	});
	cases.push({ kind, values, observed });
}

const source = input();
delete source[3];
const late = new Kernel(source);
let inheritedReads = 0;
const prototype = Object.create(Array.prototype);
Object.defineProperty(prototype, "3", {
	get() {
		inheritedReads++;
		late._retireGeneration(input().map((value) => value + 100));
		return 17;
	},
});
Object.setPrototypeOf(source, prototype);
cases.push({ values: globalThis.materialize({ kernel: late }, 8, null), inheritedReads });

let methodReads = 0;
const getter = new Kernel(input());
const original = Kernel.prototype.read;
Object.defineProperty(getter, "read", {
	get() {
		methodReads++;
		return original;
	},
});
cases.push(globalThis.materialize({ kernel: getter }, 0, null));
cases.push({ values: globalThis.materialize({ kernel: getter }, 8, null), methodReads });

let receiverReads = 0;
const proxy = new Proxy(
	{ kernel: new Kernel(input()) },
	{
		get(target, key) {
			receiverReads++;
			return Reflect.get(target, key);
		},
	},
);
cases.push(globalThis.materialize(proxy, 0, null));
cases.push({ values: globalThis.materialize(proxy, 8, null), receiverReads });

const wrong = Object.create(Kernel.prototype);
cases.push(globalThis.materialize({ kernel: wrong }, 0, null));
const observed = [];
try {
	globalThis.materialize({ kernel: new Kernel(input()) }, 8, (index, owner) => {
		observed.push(index);
		if (index === 1) owner.kernel = wrong;
	});
} catch (error) {
	cases.push({ error: error instanceof TypeError, observed });
}

function escapedOutput(owner, count, choose) {
	const output = [];
	const other = [];
	const alias = choose ? output : other;
	alias.push = function (value) {
		this[this.length] = value;
		owner.kernel._retireGeneration(input().map((value) => value + 300));
	};
	for (let index = 0; index < count; index++) output.push(owner.kernel.read(index));
	return output;
}
globalThis.escapedOutput = escapedOutput;
cases.push(globalThis.escapedOutput({ kernel: new Kernel(input()) }, 8, true));

const heap = Array.from({ length: 32 }, (_, index) => ({ index }));
const heapValues = globalThis.materialize({ kernel: new Kernel(heap) }, 32, null);
cases.push(
	heapValues.map((value, index) => value === heap[index] && value.index === index),
);
console.log(JSON.stringify(cases));
