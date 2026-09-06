function check(actual, expected) {
	if (!Object.is(actual, expected))
		throw new Error(`field entry: ${actual} != ${expected}`);
}
class Standard {
	quote(order) {
		return order.net + 7;
	}
}
class Volume {
	quote(order) {
		return order.net - Math.floor(order.net / 12);
	}
}
class Priority {
	quote(order) {
		return order.net + Math.max(15, order.quantity * 3);
	}
}
const rules = [new Standard(), new Volume(), new Priority()];
let initializers = 0;
let total = 0;
for (let index = 0; index < 60; index++) {
	const order = { net: index * 7, quantity: (initializers++, (index % 9) + 1) };
	total += rules[index % 3].quote(order);
	const garbage = [{ value: index }];
	if (garbage[0].value !== index) throw new Error("surrounding allocation");
}
check(total, 12588);
check(initializers, 60);
let retained;
Standard.prototype.quote = function replacement(order) {
	retained = order;
	return order.net + order.quantity;
};
let replacementTotal = 0;
for (let index = 0; index < 6; index++) {
	const order = { net: index * 7, quantity: (initializers++, index + 1) };
	replacementTotal += rules[index % 3].quote(order);
}
check(replacementTotal, 141);
check(retained.net, 21);
check(retained.quantity, 4);
check(initializers, 66);
let getterReads = 0;
const getter = {
	get net() {
		getterReads++;
		return 120;
	},
	quantity: 2,
};
check(rules[1].quote(getter), 110);
check(getterReads, 2);
const alias = { net: 24, quantity: 2 };
check(rules[1].quote(alias), 22);
alias.net = 48;
check(rules[1].quote(alias), 44);
class Identity {
	read(order) {
		return [order, order.net];
	}
}
class Retainer {
	read(order) {
		retained = order;
		return order.net;
	}
}
class Mutator {
	read(order) {
		order.net++;
		return order.net;
	}
}
const negative = [new Identity(), new Retainer(), new Mutator()];
const returned = negative[0].read({ net: 4 });
check(returned[0].net, returned[1]);
check(negative[1].read({ net: 8 }), 8);
check(retained.net, 8);
check(negative[2].read({ net: 10 }), 11);
const zeroRules = [new Volume(), new Priority()];
for (let index = 0; index < 8; index++) {
	const net = index % 2 ? -0 : Infinity;
	const actual = zeroRules[index % 2].quote({ net, quantity: 0 });
	check(actual, index % 2 ? 15 : NaN);
}
console.log("read-only-field-entries PASS");
