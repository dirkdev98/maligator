// Deleting `cached` moves `id` to another slot, so the reading loop meets
// entries in two layouts.
function entry(index) {
	const result = { cached: index * 2, id: index };
	if (index % 3 === 0) delete result.cached;
	return result;
}

const entries = [];
for (let round = 0; round < 10_000; round++) entries.push(entry(round));
let total = 0;
for (const item of entries) total += item.id;
console.log(total);
