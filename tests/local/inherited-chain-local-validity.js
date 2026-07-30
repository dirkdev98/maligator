function loadProbe(value) {
	return value.probe;
}

const stablePrototype = { probe: 3 };
const stableReceiver = Object.create(stablePrototype);
const unrelatedPrototype = {};
Object.create(unrelatedPrototype);

let total = 0;
for (let i = 0; i < 15; i++) {
	if (i === 10) {
		// This is structurally relevant to a different prototype chain. It must
		// not invalidate the warmed stableReceiver site.
		unrelatedPrototype.shadow = 1;
	}
	total += loadProbe(stableReceiver);
}

if (total !== 45) throw new Error("FAIL inherited chain-local validity");
console.log("inherited-chain-local-validity PASS");
