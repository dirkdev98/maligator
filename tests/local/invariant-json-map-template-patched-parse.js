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

function patchedParseFirst(text) {
	const normalize = makeNormalizer(0.1);
	const originalParse = JSON.parse;
	let calls = 0;
	let total = 0;
	for (let round = 0; round < 3; round++) {
		if (round === 0) {
			JSON.parse = function patchedParse(value) {
				calls++;
				const rows = originalParse(value);
				rows[0].id = 7;
				return rows;
			};
		} else if (round === 1) {
			JSON.parse = originalParse;
		}
		total += JSON.parse(text).map(normalize)[0].id;
	}
	JSON.parse = originalParse;
	if (calls !== 1) throw new Error(`patched parse calls ${calls}`);
	return total;
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
]);
if (patchedParseFirst(text) !== 9) throw new Error("patched parse template replay");
console.log("invariant-json-map-template-patched-parse PASS 1/1");
