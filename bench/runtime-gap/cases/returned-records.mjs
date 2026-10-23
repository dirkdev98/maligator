import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 7;
const words = ["let", "x1", "=", "y22", "+", "zz333", ";", "return", "w4444"];
const text = Array.from(
	{ length: 4_096 },
	(_, index) => words[(index * 7 + seed) % words.length],
).join(" ");

// The scanning loop keeps this helper out of line in its callers.
function nextToken(source, start) {
	let end = start;
	let digits = 0;
	while (end < source.length && source.charCodeAt(end) !== 32) {
		const code = source.charCodeAt(end);
		if (code >= 48 && code <= 57) digits++;
		end++;
	}
	return { start, end, digits };
}

function tokenWeight(source) {
	let weight = 0;
	for (let index = 0; index < source.length;) {
		const token = nextToken(source, index);
		weight = (weight + (token.end - token.start) * 3 + token.digits) | 0;
		index = token.end + 1;
	}
	return weight;
}

function run(scale) {
	let checksum = 0;
	const passes = 24 * scale;
	for (let pass = 0; pass < passes; pass++)
		checksum = (checksum * 31 + tokenWeight(text)) | 0;
	return { checksum: checksum >>> 0, operations: passes * 4_096 };
}

runRuntimeGapCase("returned-records", run);
