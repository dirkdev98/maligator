// Broad string-processing benchmark: tokenize a reusable record batch through
// String slicing/splitting/trimming and RegExp captures, then retain tiny slices
// from large one-shot parents to guard against dependent-slice retention.
// Bounded and deterministic; prints one checksum shared with Node/V8.

const users = ["alpha", "bravo", "charlie", "delta"];
const actions = ["read", "write", "update", "delete"];
const records = [];
for (let i = 0; i < 32; i++) {
	records.push(
		"  user=" +
			users[i % users.length] +
			",action=" +
			actions[(i * 3) % actions.length] +
			",value=" +
			((i * 7919) % 100000) +
			",payload=" +
			String.fromCharCode(97 + (i % 26)).repeat(48) +
			"  ",
	);
}
const batch = records.join("|");
const recordPattern = /^user=([a-z]+),action=([a-z]+),value=([0-9]+),payload=([a-z]+)$/;
const valuePattern = /value=([0-9]+)/g;

function processBatch(input) {
	const fields = input.trim().split("|");
	let checksum = 0;
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i].trim();
		const match = recordPattern.exec(field);
		if (match === null) throw new Error("record did not match");

		const prefix = field.slice(0, 12);
		const payload = field.substring(field.length - 48);
		checksum =
			(checksum +
				match[1].length * 3 +
				match[2].length * 5 +
				Number(match[3]) +
				match[4].length * 7 +
				prefix.charCodeAt(0) +
				payload.charCodeAt(0) +
				field.charAt(1).charCodeAt(0) +
				field.at(-1).charCodeAt(0)) %
			1000000007;
	}

	valuePattern.lastIndex = 0;
	for (const match of input.matchAll(valuePattern)) {
		checksum = (checksum + Number(match[1])) % 1000000007;
	}
	return checksum;
}

let checksum = 0;
for (let i = 0; i < 2000; i++) {
	checksum = (checksum + processBatch(batch)) % 1000000007;
}

// A tiny retained result must not pin each large parent. This phase is small
// relative to the tokenizer but loud in peak-live metrics if retention regresses.
const retained = [];
for (let i = 0; i < 96; i++) {
	const large = String.fromCharCode(97 + (i % 26)).repeat(65536) + ":" + i;
	retained.push(large.slice(-8));
}
for (let i = 0; i < retained.length; i++) checksum += retained[i].length;

console.log(checksum);
