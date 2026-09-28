import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	let checksum = 0;
	const operations = 4 * scale;
	for (let batch = 0; batch < operations; batch++) {
		const values = new Map();
		let key = "";
		for (let index = 0; index < 1024; index++) {
			key += "abcdefghijklmnop" + String.fromCharCode(65 + (index & 15));
			values.set(key, index);
			checksum = (checksum + values.get(key) + key.length) | 0;
		}
	}
	return { checksum: checksum >>> 0, operations: operations * 1024 };
}

runRuntimeGapCase("string-append-hash", run);
