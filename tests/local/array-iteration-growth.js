"use strict";

const collect = globalThis.__mal_collect_garbage ?? globalThis.gc;
const source = Array.from({ length: 65540 }, (_, index) => index);
let matches = 0;
for (let round = 0; round < 2; round++) {
	const shared = { value: round };
	const mapped = source.map((value) => {
		const result =
			(value & 4095) === 0 || value >= source.length - 6
				? { value: value + round }
				: shared;
		// Collect around every geometric growth boundary and the final wide stores.
		if ((value & (value - 1)) === 0 || value >= source.length - 6) collect();
		return result;
	});
	const filtered = mapped.filter((value, index) => {
		if ((index & (index - 1)) === 0 || index >= source.length - 6) collect();
		return value.value >= round;
	});
	collect();
	if (
		mapped.length === source.length &&
		filtered.length === source.length &&
		filtered[65539] === mapped[65539] &&
		filtered[65539].value === 65539 + round &&
		filtered[32768].value === 32768 + round &&
		filtered[1] === shared
	)
		matches++;
}
if (matches !== 2) throw new Error("map/filter growth lost values or identity");
console.log("array-iteration-growth PASS");
