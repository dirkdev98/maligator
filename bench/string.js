// Structured-text processing benchmark: varied log batches exercise String and
// RegExp parsing, normalization, search, replacement, case conversion, slicing,
// and tokenization. A final phase retains tiny slices from large one-shot parents
// to guard against dependent-slice retention. Bounded and deterministic.

const MOD = 1000000007;
const users = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
const actions = ["read", "write", "update", "delete"];
const levels = ["INFO", "WARN", "DEBUG"];
const paths = ["/api/items", "/api/profile", "/jobs/export", "/health/live"];
const tagSets = ["cache,edge", "db,primary", "queue,batch", "auth,session"];
const batches = [];

for (let batchIndex = 0; batchIndex < 8; batchIndex++) {
	const records = [];
	for (let i = 0; i < 48; i++) {
		const index = batchIndex * 48 + i;
		records.push(
			"  level=" +
				levels[index % levels.length] +
				";user=" +
				users[index % users.length] +
				"-" +
				(index % 17) +
				";action=" +
				actions[(index * 3) % actions.length] +
				";path=" +
				paths[(index * 5) % paths.length] +
				"/" +
				(index % 101) +
				";value=" +
				((index * 7919) % 100000) +
				";tags=" +
				tagSets[(index * 7) % tagSets.length] +
				";payload=" +
				String.fromCharCode(97 + (index % 26)).repeat(32 + (index % 4) * 8) +
				"  ",
		);
	}
	batches.push(records.join(batchIndex % 2 === 0 ? "\n" : "\r\n"));
}

const recordPattern = /^level=([A-Z]+);user=([a-z]+)-([0-9]+);action=([a-z]+);/;
const valuePattern = /value=([0-9]+)/g;
const payloadPattern = /payload=[a-z]+/g;
const redactedBatches = batches.map((input) =>
	input.replace(payloadPattern, "payload=<redacted>"),
);

function processBatch(input, redacted) {
	const records = input.trim().split(input.includes("\r\n") ? "\r\n" : "\n");
	let checksum = 0;
	for (let i = 0; i < records.length; i++) {
		const record = records[i].trim();
		const match = recordPattern.exec(record);
		if (match === null) throw new Error("record did not match");

		const fields = record.split(";");
		const pathStart = record.indexOf("path=");
		const valueStart = record.search(/value=/);
		const payloadStart = record.lastIndexOf("payload=");
		const path = record.slice(pathStart + 5, valueStart - 1);
		const value = Number(fields[4].slice(6));
		const tags = fields[5].slice(5).split(",");
		const normalizedAction = match[4].toUpperCase().toLowerCase();
		const payload = record.substring(payloadStart + 8);
		if (
			!record.startsWith("level=") ||
			!record.includes(";tags=") ||
			!record.endsWith(payload)
		) {
			throw new Error("record normalization failed");
		}
		checksum =
			(checksum +
				match[1].length * 3 +
				match[2].charCodeAt(0) +
				Number(match[3]) * 5 +
				normalizedAction.length * 7 +
				value +
				tags[0].length * 11 +
				tags[1].length * 13 +
				fields.length * 17 +
				path.charCodeAt(path.length - 1) +
				payload.charCodeAt(0) +
				payload.at(-1).charCodeAt(0)) %
			MOD;
	}
	checksum =
		(checksum + redacted.length + redacted.charCodeAt(redacted.length - 1)) % MOD;

	valuePattern.lastIndex = 0;
	for (const match of input.matchAll(valuePattern)) {
		checksum = (checksum + Number(match[1])) % MOD;
	}
	return checksum;
}

let checksum = 0;
for (let i = 0; i < 2200; i++) {
	const batchIndex = (i * 5) % batches.length;
	checksum =
		(checksum + processBatch(batches[batchIndex], redactedBatches[batchIndex])) % MOD;
}

// A tiny retained result must not pin each large parent. This phase is small
// relative to parsing but loud in peak-live metrics if retention regresses.
const retained = [];
for (let i = 0; i < 96; i++) {
	const large = String.fromCharCode(97 + (i % 26)).repeat(65536) + ":" + i;
	retained.push(large.slice(-8));
}
for (let i = 0; i < retained.length; i++) checksum += retained[i].length;

const EXPECTED_CHECKSUM = 552837773;
if (checksum !== EXPECTED_CHECKSUM) {
	throw new Error("string checksum " + checksum + " expected " + EXPECTED_CHECKSUM);
}
console.log(checksum);
