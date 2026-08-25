"use strict";

function allocateContribution(index) {
	return {
		delta: (index % 5) + 1,
		payload: [index, String(index), { index }],
	};
}

function walk(seed, callback) {
	let held = { value: seed, previous: null };
	for (let index = 0; index < 120; index++) {
		const before = held;
		try {
			const contribution = callback(index);
			if (index % 13 === 7) throw { delta: index % 4 };
			held = {
				value: before.value + contribution.delta,
				previous: before,
			};
		} catch (error) {
			held = {
				value: before.value + error.delta + 1,
				previous: before,
			};
		}
	}
	return held.value + held.previous.value;
}

console.log(walk(11, allocateContribution));
