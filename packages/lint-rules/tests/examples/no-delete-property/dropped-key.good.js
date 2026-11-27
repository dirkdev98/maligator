// Clearing `cached` keeps every entry in the shape its literal created.
function entry(index) {
	const result = { id: index, cached: index * 2 };
	if (index % 3 === 0) result.cached = undefined;
	return result;
}

const entries = [];
for (let round = 0; round < 10_000; round++) entries.push(entry(round));
let total = 0;
for (const item of entries) total += item.id;
console.log(total);
