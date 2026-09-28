import { runRuntimeGapCase } from "../case-runner.mjs";

const leaves = [];
for (let index = 0; index < 1024; index++) {
	leaves.push(
		"abcdefghijklmnop" +
			String.fromCharCode(65 + (index & 15)) +
			((index & 7) === 0 ? "\u0100\ud83d\ude00" : ""),
	);
}
const value = leaves.join("");

function run(scale) {
	let checksum = 5381;
	const operations = 32 * scale;
	for (let batch = 0; batch < operations; batch++) {
		for (const character of value) {
			checksum = (checksum * 33 + character.charCodeAt(0)) | 0;
			if (character.length === 2) {
				checksum = (checksum * 33 + character.charCodeAt(1)) | 0;
			}
		}
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("string-flat-iteration", run);
