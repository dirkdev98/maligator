const readings = [1, undefined, 2];

let total = 0;
for (let round = 0; round < 10_000; round++) {
	for (const reading of readings) total += reading ?? 0;
}
console.log(total);
