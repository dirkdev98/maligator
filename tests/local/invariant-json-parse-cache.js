const text = '[{"id":1,"meta":{"region":"north"}},{}]';
const originalParse = JSON.parse;
let patchedCalls = 0;
let previous;

for (let round = 0; round < 7; round++) {
	if (round === 3) {
		JSON.parse = function patchedParse(value) {
			patchedCalls++;
			return originalParse(value);
		};
	} else if (round === 4) {
		JSON.parse = originalParse;
	}
	const input = round === 6 ? '[{"id":2}]' : text;
	const value = JSON.parse(input);
	if (round === 6) {
		if (value[0].id !== 2) throw new Error("changed input was cached");
		continue;
	}
	if (
		value === previous ||
		value[0] === previous?.[0] ||
		value[0].meta === previous?.[0]?.meta ||
		value.length !== 2 ||
		value[0].id !== 1 ||
		value[0].meta.region !== "north"
	) {
		throw new Error("parse result identity or value was reused");
	}
	previous = value;
	value[0].id = 99;
	value[0].meta.region = "mutated";
	value.push({ id: 3 });
}

JSON.parse = originalParse;
if (patchedCalls !== 1) throw new Error(`patched parse calls ${patchedCalls}`);

if (typeof $262 !== "undefined") {
	const foreign = $262.createRealm().global;
	const foreignParse = foreign.JSON.parse;
	for (let round = 0; round < 4; round++) {
		const value = foreignParse('[{"nested":{}}]');
		if (
			foreign.Object.getPrototypeOf(value) !== foreign.Array.prototype ||
			foreign.Object.getPrototypeOf(value[0]) !== foreign.Object.prototype ||
			foreign.Object.getPrototypeOf(value[0].nested) !== foreign.Object.prototype
		) {
			throw new Error("foreign JSON.parse result acquired current-Realm prototypes");
		}
	}
}

console.log("invariant-json-parse-cache PASS 2/2");
