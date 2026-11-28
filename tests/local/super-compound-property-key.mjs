const trace = [];
const property = Symbol("balance");
const key = {
	[Symbol.toPrimitive](hint) {
		if (trace.length !== 0) throw new Error("key converted again");
		trace.push(hint);
		return property;
	},
};

const parent = {
	get [property]() {
		trace.push("get");
		return this.balance;
	},
	set [property](value) {
		trace.push("set");
		this.balance = value;
	},
};

function amount() {
	trace.push("rhs");
	return 3;
}

const account = {
	__proto__: parent,
	balance: 2,
	credit() {
		return (super[key] += amount());
	},
};

console.log(JSON.stringify([account.credit(), account.balance, trace]));
