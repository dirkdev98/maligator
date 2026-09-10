import { readFileSync } from "node:fs";

interface Order {
	id: number;
	region: string;
	category: string;
	quantity: number;
	price: number;
	cancelled: boolean;
}
interface Total {
	key: string;
	orders: number;
	quantity: number;
	cents: number;
}

const file = process.argv[2];
const iterations = Number(process.argv[3]);
if (file === undefined || !Number.isInteger(iterations) || iterations < 1) {
	throw new Error("usage: app-batch INPUT ITERATIONS");
}
const input = readFileSync(file, "utf8");
let checksum = 2166136261;
let rowCount = 0;
let serialized = "";
for (let iteration = 0; iteration < iterations; iteration++) {
	const orders = JSON.parse(input) as Array<Order>;
	rowCount = orders.length;
	const totals = new Map<string, Total>();
	for (const order of orders) {
		if (!Number.isInteger(order.quantity) || !Number.isInteger(order.price)) {
			throw new Error("invalid order amount");
		}
		if (order.cancelled) continue;
		const key = `${order.region}/${order.category}`;
		let total = totals.get(key);
		if (total === undefined) {
			total = { key, orders: 0, quantity: 0, cents: 0 };
			totals.set(key, total);
		}
		total.orders++;
		total.quantity += order.quantity;
		total.cents += order.quantity * order.price;
	}
	const summary = [...totals.values()]
		.filter((total) => total.orders > 0)
		.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
	serialized = JSON.stringify(summary);
	for (let index = 0; index < serialized.length; index++) {
		checksum = Math.imul(checksum ^ serialized.charCodeAt(index), 16777619) >>> 0;
	}
}
console.log(
	JSON.stringify({
		rows: rowCount,
		iterations,
		checksum,
		summary: JSON.parse(serialized),
	}),
);
