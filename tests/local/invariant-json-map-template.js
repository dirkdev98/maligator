function makeNormalizer(rate = 0) {
	return function normalize({
		id,
		customer = "guest",
		qty = 1,
		price = 0,
		discount = 0,
		meta,
		...rest
	}) {
		return {
			...rest,
			id,
			customer,
			qty,
			net: Math.round((qty * price - discount) * (1 + rate)),
			region: meta?.region ?? "unknown",
		};
	};
}

function repeated(text) {
	const normalize = makeNormalizer(0.1);
	let previous;
	let checksum = 0;
	for (let round = 0; round < 6; round++) {
		const rows = JSON.parse(text).map(normalize);
		if (
			rows === previous ||
			rows[0] === previous?.[0] ||
			rows[0].channel !== "web" ||
			rows[0].id !== 1 ||
			rows[0].net !== 20 ||
			rows[0].region !== "north" ||
			rows[1].region !== "unknown" ||
			Object.keys(rows[0]).join(",") !== "channel,id,customer,qty,net,region"
		) {
			throw new Error("linked map value, identity, or property order was reused");
		}
		checksum += rows[0].net + rows[1].net;
		previous = rows;
		rows[0].id = 99;
		rows[0].channel = "mutated";
		rows.push({});
	}
	return checksum;
}

const text = JSON.stringify([
	{
		id: 1,
		customer: "a",
		qty: 2,
		price: 10,
		discount: 2,
		meta: { region: "north" },
		channel: "web",
	},
	{ id: 2, customer: "b", qty: 1, price: 5, discount: 0, meta: null, channel: "store" },
]);
if (repeated(text) !== 156 || repeated(text) !== 156) {
	throw new Error("linked map checksum or activation-local refill");
}
console.log("invariant-json-map-template PASS 1/1");
