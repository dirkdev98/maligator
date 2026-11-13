const results = [];
function show(value) {
	return Object.is(value, -0) ? "-0" : String(value);
}
function record(label, value) {
	results.push(`${label}=${show(value)}`);
}

class Account {
	constructor(offset) {
		this.offset = offset;
	}
	calculate(prefix, value) {
		return prefix + value + this.offset;
	}
}

function fieldSum(n, account) {
	let c = 0;
	for (let i = 0; i < n; i++) c += 7 + (i & 1023) + account.offset;
	return c;
}
function fieldStart(n, account) {
	let c = -0;
	for (let i = 0; i < n; i++) c += account.offset;
	return c;
}
function methodSum(n, account) {
	let c = 0;
	for (let i = 0; i < n; i++) c += account.calculate(7, i & 15);
	return c;
}
const shared = new Account(11);
function sharedSum(n) {
	let c = 0;
	for (let i = 0; i < n; i++) c += shared.calculate(1, i & 7);
	return c;
}
function nestedSum(n, holder) {
	let c = 0;
	for (let i = 0; i < n; i++) c += holder.account.offset * (i & 3);
	return c;
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
	scaled() {
		let t = -0;
		for (const item of this.list) t += item.price * this.discount;
		return t;
	}
	indexed() {
		let t = 0;
		for (let i = 0; i < this.list.length; i++) t += this.list[i].price - this.discount;
		return t;
	}
}

class Samples {
	constructor(length, scale) {
		this.data = new Float64Array(length).map((_, i) => i & 15);
		this.scale = scale;
	}
	weighted() {
		let t = 0;
		for (let i = 0; i < this.data.length; i++) t += this.data[i] * this.scale;
		return t;
	}
	stepper(n) {
		return () => {
			let t = 0;
			for (let i = 0; i < n; i++) t += (i & 3) * this.scale;
			return t;
		};
	}
}
function captured(config) {
	return (n) => {
		let t = 0;
		for (let i = 0; i < n; i++) t += config.step * (i & 3);
		return t;
	};
}

class Base {
	constructor(offset) {
		this.offset = offset;
	}
}
class Totaled extends Base {
	constructor(offset, n) {
		super(offset);
		let c = 0;
		for (let i = 0; i < n; i++) c += this.offset + (i & 1);
		this.total = c;
	}
}

// Stores and calls inside a loop can change the field between iterations.
function storingSum(n, account) {
	let c = 0;
	for (let i = 0; i < n; i++) {
		if (i === 5) account.offset = "s";
		c += account.offset;
	}
	return c;
}
function install(account, i) {
	if (i === 3)
		Object.defineProperty(account, "offset", {
			get() {
				return 100;
			},
			configurable: true,
		});
	if (i === 6) {
		delete account.offset;
		account.extra = 1;
		account.offset = 0.5;
	}
}
function callingSum(n, account) {
	let c = 0;
	for (let i = 0; i < n; i++) {
		install(account, i);
		c += account.offset;
	}
	return c;
}

const loops = 200;
let warm = 0;
const samples = new Samples(40, 3);
const step = samples.stepper(12);
const stepped = captured({ step: 5 });
for (let i = 0; i < loops; i++) {
	warm += fieldSum(64, shared) + methodSum(16, shared) + sharedSum(16);
	warm += nestedSum(32, { account: shared }) + samples.weighted() + step() + stepped(9);
}
record("warm", warm);
record("loops", loops);

const account = new Account(3);
record("field", fieldSum(2000, account));
account.offset = 2.5;
record("fraction", fieldSum(100, account));
account.offset = NaN;
record("nan", fieldSum(10, account));
account.offset = -0;
record("negativeZero", fieldStart(10, account));
account.offset = "x";
record("string", fieldSum(4, account));
account.offset = 2 ** 53;
record("unsafe", fieldSum(4, account));
Object.defineProperty(account, "offset", {
	get() {
		return 4;
	},
	configurable: true,
});
record("ownGetter", fieldSum(10, account));

class Inherited {
	get offset() {
		return 5;
	}
}
record("protoGetter", fieldSum(10, new Inherited()));
const shifted = new Account(1);
delete shifted.offset;
shifted.before = 0;
shifted.offset = 6;
record("shape", fieldSum(10, shifted));
record("missing", fieldSum(3, {}));
record("proxy", fieldSum(5, new Proxy({ offset: 7 }, {})));
const trapped = new Proxy(
	{},
	{
		get(target, key) {
			return key === "offset" ? 9 : undefined;
		},
	},
);
record("trap", fieldSum(5, trapped));

const replaced = new Account(2);
record("method", methodSum(100, replaced));
replaced.calculate = function (prefix, value) {
	return prefix * value - this.offset;
};
record("ownMethod", methodSum(100, replaced));
record("stringMethod", methodSum(3, new Account("y")));
const saved = Account.prototype.calculate;
Account.prototype.calculate = function () {
	return 1;
};
record("protoMethod", sharedSum(10));
Account.prototype.calculate = saved;
record("restored", sharedSum(10));

const items = Array.from({ length: 50 }, (_, i) => ({ price: i & 7 }));
const cart = new Cart(items, 2);
record("cart", cart.total());
cart.discount = 0.25;
record("cartFraction", cart.total());
cart.discount = "d";
record("cartString", cart.total());
cart.discount = -0;
record("cartNegativeZero", cart.scaled());
cart.discount = NaN;
record("cartNan", cart.total());
Object.defineProperty(cart, "discount", {
	get() {
		return 1;
	},
});
record("cartGetter", cart.total());

record("cartIndexed", cart.indexed());
cart.list = [{ price: 1 }, { price: "p" }, { price: 3 }];
record("cartIndexedString", cart.indexed());
record("weighted", samples.weighted());
samples.scale = 0.5;
record("weightedFraction", samples.weighted());
samples.data = new Int8Array([1, -2, 3]);
record("weightedInt8", samples.weighted());
samples.data = [1, 2, , 4];
record("weightedHoles", samples.weighted());
samples.data = "1234";
record("weightedString", samples.weighted());
samples.scale = "k";
record("stepString", step());
record("derived", new Totaled(4, 10).total);
record("derivedString", new Totaled("o", 3).total);

record("storing", storingSum(8, new Account(1)));
record("calling", callingSum(9, new Account(1)));

console.log(results.join("\n"));
