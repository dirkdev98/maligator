// Every entry is created with all of its keys, so `nameLength` reads one shape.
function privateName(flags) {
	const entry = {
		name: "#field",
		field: undefined,
		method: undefined,
		getter: undefined,
	};
	if (flags & 1) entry.field = flags;
	if (flags & 2) entry.method = flags;
	if (flags & 4) entry.getter = flags;
	return entry;
}

function nameLength(entry) {
	return entry.name.length;
}

let total = 0;
for (let round = 0; round < 10_000; round++) total += nameLength(privateName(round & 7));
console.log(total);
