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

const ordinary = JSON.stringify([
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

let coercions = 0;
const objectRate = {
	valueOf() {
		coercions++;
		return 0.1;
	},
};
function objectCapture(text) {
	const normalize = makeNormalizer(objectRate);
	let total = 0;
	for (let round = 0; round < 3; round++) total += JSON.parse(text).map(normalize)[0].net;
	return total;
}
if (objectCapture(ordinary) !== 60 || coercions !== 3)
	throw new Error("object capture effects elided");

function objectInput(text) {
	const normalize = makeNormalizer(0.1);
	let total = 0;
	for (let round = 0; round < 3; round++) {
		const row = JSON.parse(text).map(normalize)[0];
		if (typeof row.channel !== "object" || typeof row.region !== "object") {
			throw new Error("object-valued output was templated");
		}
		total += row.net;
	}
	return total;
}
const objectText = JSON.stringify([
	{
		id: 1,
		customer: "a",
		qty: 2,
		price: 10,
		discount: 2,
		meta: { region: { name: "north" } },
		channel: { kind: "web" },
	},
]);
if (objectInput(objectText) !== 60) throw new Error("object input result");

function changedText(first, second) {
	const normalize = makeNormalizer(0.1);
	let total = 0;
	let text = first;
	for (let round = 0; round < 3; round++) {
		total += JSON.parse(text).map(normalize)[0].id;
		text = round === 0 ? second : first;
	}
	return total;
}
const changed = ordinary.replace('"id":1', '"id":9');
if (changedText(ordinary, changed) !== 11) throw new Error("changed text was cached");

function patchedIntrinsics(text) {
	const normalize = makeNormalizer(0.1);
	const originalRound = Math.round;
	const originalMap = Array.prototype.map;
	const species = Object.getOwnPropertyDescriptor(Array, Symbol.species);
	let roundCalls = 0;
	let mapCalls = 0;
	let speciesCalls = 0;
	let total = 0;
	for (let round = 0; round < 5; round++) {
		if (round === 1)
			Math.round = function patchedRound(value) {
				roundCalls++;
				return originalRound(value) + 100;
			};
		if (round === 2) {
			Math.round = originalRound;
			Array.prototype.map = function patchedMap(callback) {
				mapCalls++;
				return originalMap.call(this, callback);
			};
		}
		if (round === 3) {
			Array.prototype.map = originalMap;
			Object.defineProperty(Array, Symbol.species, {
				configurable: true,
				get() {
					speciesCalls++;
					return Array;
				},
			});
		}
		if (round === 4) Object.defineProperty(Array, Symbol.species, species);
		total += JSON.parse(text).map(normalize)[0].net;
	}
	Math.round = originalRound;
	Array.prototype.map = originalMap;
	Object.defineProperty(Array, Symbol.species, species);
	if (roundCalls !== 1 || mapCalls !== 1 || speciesCalls !== 1) {
		throw new Error(`patched calls ${roundCalls}/${mapCalls}/${speciesCalls}`);
	}
	return total;
}
if (patchedIntrinsics(ordinary) !== 200) throw new Error("patched intrinsic result");

console.log("invariant-json-map-template-adversarial PASS 1/1");
