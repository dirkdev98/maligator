const results = [];
function show(value) {
	return Object.is(value, -0) ? "-0" : String(value);
}
function record(label, value) {
	results.push(`${label}=${show(value)}`);
}

// A plain function an object literal holds is called as that object's method.
function receiverCall(prefix, value) {
	return prefix + value + this.offset;
}
function otherCall(prefix, value) {
	return prefix * value - this.offset;
}
const literal = { offset: 11, calculate: receiverCall };
const named = { offset: 4, receiverCall };
function literalSum(n) {
	let c = 0;
	for (let i = 0; i < n; i++) c += literal.calculate(7, i & 1023);
	return c;
}
function namedSum(n) {
	let c = 0;
	for (let i = 0; i < n; i++) c += named.receiverCall(2, i & 15);
	return c;
}
// Each call may replace the method the next one reads.
function swappingSum(n) {
	let c = 0;
	for (let i = 0; i < n; i++) {
		if (i === 3) literal.calculate = otherCall;
		c += literal.calculate(7, i & 7);
	}
	return c;
}

class Account {
	constructor(offset) {
		this.offset = offset;
	}
	calculate(prefix, value) {
		return prefix + value + this.offset;
	}
}
class Ledger {
	constructor(offset) {
		this.offset = offset;
		this.extra = 1;
	}
	calculate(prefix, value) {
		return prefix + value + this.offset + this.extra;
	}
}
const shorthand = {
	offset: 3,
	calculate(prefix, value) {
		return prefix - value + this.offset;
	},
};
// One site that sees class instances and literals alike.
function dispatchSum(n, receiver) {
	let c = 0;
	for (let i = 0; i < n; i++) c += receiver.calculate(7, i & 1023);
	return c;
}

// Fields only `this` ever stores, in a constructor its loop keeps a call, stay class
// layout keys, so reads of them anywhere guard on the class cell.
class Item {
	constructor(i) {
		this.price = i & 63;
		this.qty = 1 + (i & 3);
		for (let k = 0; k < (i & 1); k++) this.qty += 0;
	}
	reprice(price) {
		this.price = price;
		return this;
	}
	requantify(qty) {
		this.qty = qty;
		return this;
	}
}
class Discounted extends Item {
	constructor(i) {
		super(i);
		this.rate = 2;
	}
}
function forOfTotal(list) {
	let t = 0;
	for (const item of list) t += item.price * item.qty;
	return t;
}
function indexedTotal(list) {
	let t = 0;
	for (let i = 0; i < list.length; i++) t += list[i].price;
	return t;
}
class Cart {
	constructor(list, discount) {
		this.list = list;
		this.discount = discount;
	}
	total() {
		let t = 0;
		for (const item of this.list) t += item.price - this.discount;
		return t;
	}
}

const items = [];
for (let i = 0; i < 200; i++) items.push(new Item(i));
const cart = new Cart(items, 2);
const instance = new Account(11);
const ledger = new Ledger(5);

// Each warm round runs seven loops through functions of their own.
const rounds = [
	() => literalSum(64),
	() => namedSum(16),
	() => dispatchSum(32, instance),
	() => dispatchSum(32, literal),
	() => dispatchSum(32, ledger),
	() => dispatchSum(32, shorthand),
	() => cart.total(),
];
const loops = 200;
let warm = 0;
for (let i = 0; i < loops; i++) for (const round of rounds) warm += round();
for (let i = 0; i < loops; i++) warm += forOfTotal(items) + indexedTotal(items);
record("warm", warm);
record("loops", loops);
record("items", items.length);

record("literal", literalSum(1000));
literal.offset = 2.5;
record("literalFraction", literalSum(10));
literal.offset = "s";
record("literalString", literalSum(3));
literal.offset = 11;
record("swapping", swappingSum(8));
record("swapped", literalSum(10));
literal.calculate = receiverCall;
record("restored", literalSum(10));
Object.defineProperty(literal, "calculate", {
	get() {
		return otherCall;
	},
	configurable: true,
});
record("getterMethod", literalSum(10));
Object.defineProperty(literal, "calculate", { value: receiverCall, writable: true });
record("redefined", literalSum(10));
record("named", namedSum(100));

record("instance", dispatchSum(100, instance));
record("ledger", dispatchSum(100, ledger));
record("literalReceiver", dispatchSum(100, literal));
record("shorthandReceiver", dispatchSum(100, shorthand));
// A receiver whose method no class or literal names takes the ordinary call.
const assembled = { offset: 1 };
assembled.calculate = function (prefix, value) {
	return value - prefix - this.offset;
};
record("unexpected", dispatchSum(100, assembled));
record("strictPrimitive", receiverCall.call(5, 1, 2));
record("missingOffset", dispatchSum(10, { calculate: receiverCall }));
record("proxy", dispatchSum(10, new Proxy(literal, {})));
instance.calculate = otherCall;
record("ownOverride", dispatchSum(10, instance));
delete instance.calculate;
const savedCalculate = Account.prototype.calculate;
Account.prototype.calculate = otherCall;
record("protoOverride", dispatchSum(10, instance));
Account.prototype.calculate = savedCalculate;
record("protoRestored", dispatchSum(10, instance));

record("forOf", forOfTotal(items));
record("indexed", indexedTotal(items));
record("cart", cart.total());
const mixed = items.slice(0, 20);
mixed.push(new Discounted(9), JSON.parse('{"price":4,"qty":2}'), new Item(3));
record("mixedForOf", forOfTotal(mixed));
record("mixedIndexed", indexedTotal(mixed));
const fractional = items.slice(0, 10);
fractional[4] = new Item(4).reprice(0.5);
record("fractionalField", forOfTotal(fractional));
const stringy = items.slice(0, 10);
stringy[6] = new Item(6).requantify("q");
record("stringField", forOfTotal(stringy));
// Turning one element's field into a getter leaves that element's class layout.
const watched = items.slice(0, 30);
watched[12] = new Item(12);
let getterCalls = 0;
Object.defineProperty(watched[12], "price", {
	get() {
		getterCalls++;
		return 100;
	},
});
record("getterField", forOfTotal(watched));
record("getterIndexed", indexedTotal(watched));
record("getterCalls", getterCalls);
const sparse = items.slice(0, 5);
sparse[7] = new Item(7);
try {
	indexedTotal(sparse);
} catch (error) {
	record("holes", error.name);
}

console.log(results.join("\n"));
