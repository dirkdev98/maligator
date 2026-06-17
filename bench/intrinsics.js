// Intrinsics: Math, Array.prototype iteration methods, and String building.
// The working array is allocated once; reduce/forEach do not allocate per
// iteration, so memory stays bounded. Exercises native callback dispatch
// (the map/filter/reduce path), Math.*, and string concatenation.

const N = 4000;
const data = [];
for (let i = 0; i < N; i++) {
	data.push(((i * 2654435761) % 10007) / 10007);
}

let acc = 0;
for (let iter = 0; iter < 600; iter++) {
	// reduce + Math intrinsics over a fixed array (no allocation).
	const s = data.reduce(function (sum, v) {
		return sum + Math.sqrt(v) * Math.sin(v) + Math.abs(v - 0.5);
	}, 0);

	// forEach with a branch and a closed-over accumulator.
	let hits = 0;
	data.forEach(function (v) {
		if (v > 0.5) {
			hits = hits + Math.floor(v * 100);
		}
	});

	acc = acc + s + hits;
}
console.log(Math.round(acc));
