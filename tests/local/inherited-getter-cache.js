// Inherited getters read repeatedly from one site while the chain changes.

let calls = 0;

class Base {
	constructor(value) {
		this.value = value;
	}
	get doubled() {
		calls++;
		return this.value * 2;
	}
}

class Derived extends Base {
	get label() {
		calls++;
		if (this.value < 0) throw new RangeError(`negative ${this.value}`);
		return `v${this.value}`;
	}
}

function readDoubled(object) {
	return object.doubled;
}

function readKey(object, key) {
	return object[key];
}

const lines = [];
const items = [new Derived(1), new Derived(2), new Derived(3)];
let sum = 0;
for (let round = 0; round < 50; round++)
	for (const item of items) sum += readDoubled(item);
lines.push(`steady ${sum} calls ${calls}`);

Object.defineProperty(Base.prototype, "doubled", {
	get() {
		calls++;
		return this.value * 10;
	},
	configurable: true,
});
sum = 0;
for (const item of items) sum += readDoubled(item);
lines.push(`redefined ${sum} calls ${calls}`);

const shadowed = new Derived(4);
Object.defineProperty(shadowed, "doubled", { value: "own", configurable: true });
lines.push(`own ${readDoubled(shadowed)} ${readDoubled(new Derived(5))}`);

Object.defineProperty(Derived.prototype, "doubled", {
	value: "data on Derived",
	configurable: true,
});
lines.push(`intermediate ${readDoubled(new Derived(6))}`);
delete Derived.prototype.doubled;
lines.push(`restored ${readDoubled(new Derived(7))}`);

const other = {
	get doubled() {
		return "other prototype";
	},
};
const moved = new Derived(8);
lines.push(`before move ${readDoubled(moved)}`);
Object.setPrototypeOf(moved, other);
lines.push(`after move ${readDoubled(moved)}`);

const labels = [];
for (const value of [1, 2, -3, 4]) {
	try {
		labels.push(readKey(new Derived(value), "label"));
	} catch (error) {
		labels.push(`${error.name}:${error.message}`);
	}
}
lines.push(`labels ${labels.join(",")}`);
lines.push(
	`keys ${readKey(items[0], "doubled")} ${readKey(items[0], "value")} ${readKey(items[0], "label")}`,
);

const dictionaryPrototype = {};
for (let index = 0; index < 40; index++) dictionaryPrototype[`p${index}`] = index;
delete dictionaryPrototype.p3;
Object.defineProperty(dictionaryPrototype, "doubled", {
	get() {
		return "dictionary getter";
	},
	configurable: true,
});
const dictionaryChild = Object.create(dictionaryPrototype);
lines.push(`dictionary ${readDoubled(dictionaryChild)} ${readDoubled(dictionaryChild)}`);
Object.defineProperty(dictionaryPrototype, "doubled", { value: "dictionary data" });
lines.push(`dictionary redefined ${readDoubled(dictionaryChild)}`);

console.log(lines.join("\n"));
