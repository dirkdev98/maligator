let passed = 0;

function check(name, condition) {
	if (!condition) throw new Error("closed-record-array-region failure: " + name);
	passed++;
}

function closedKernel() {
	const rows = [];
	for (let index = 0; index < 32; index++) {
		rows.push({ x: index, y: index + 1 });
	}
	let total = 0;
	for (let round = 0; round < 5; round++) {
		for (let index = 0; index < 32; index++) {
			const row = rows[index];
			row.y = row.x + row.y;
			if ((index + round) % 7 === 0) row.x = row.x + 1;
			total += row.x + row.y;
		}
	}
	return total;
}

let escaped;
function escapingKernel() {
	const rows = [];
	for (let index = 0; index < 4; index++) rows.push({ x: index, y: index + 1 });
	const row = rows[2];
	escaped = row;
	row.x = 40;
	return escaped === row && escaped.x + escaped.y === 43;
}

function shapeMutationKernel() {
	const rows = [];
	for (let index = 0; index < 4; index++) rows.push({ x: index, y: index + 1 });
	let total = 0;
	for (let index = 0; index < 4; index++) {
		const row = rows[index];
		row.extra = index * 2;
		total += row.x + row.y + row.extra;
	}
	return total;
}

function conditionalFillKernel() {
	const rows = [];
	for (let index = 0; index < 4; index++) {
		if ((index & 1) === 0) rows.push({ x: index, y: index + 1 });
	}
	let total = 0;
	for (let index = 0; index < 2; index++) total += rows[index].x + rows[index].y;
	return total;
}

check("closed nested consumer loops", closedKernel() === 12716);
check("escaping record keeps identity", escapingKernel());
check("shape mutation stays generic", shapeMutationKernel() === 28);
check("conditional fill stays generic", conditionalFillKernel() === 6);

console.log("closed-record-array-region PASS " + passed + "/" + passed);
