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
function price(rules, count) {
	let total = 0;
	for (let index = 0; index < count; index++) {
		const order = { net: index * 7, quantity: (index % 9) + 1 };
		total += rules[index % rules.length].quote(order);
	}
	return total;
}
const total = price([new Standard(), new Volume(), new Priority()], 60);
if (total !== 12588) throw new Error(`checked leaf total ${total}`);
console.log("checked-leaf-fixture PASS");
