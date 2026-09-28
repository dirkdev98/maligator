import { runRuntimeGapCase } from "../case-runner.mjs";

const leaves = [];
for (let index = 0; index < 1024; index++) {
	leaves.push("abcdefghijklmnop" + String.fromCharCode(65 + (index & 15)));
}

function run(scale) {
	let checksum = 0;
	const operations = 8 * scale;
	for (let batch = 0; batch < operations; batch++) {
		let left = "";
		let right = "";
		for (const leaf of leaves) {
			left += leaf;
			right = leaf + right;
		}
		for (let index = 0; index < left.length; index++) {
			checksum = (checksum + left.charCodeAt(index) + right.charCodeAt(index)) | 0;
		}
		for (const unit of left) checksum = (checksum + unit.charCodeAt(0)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("string-rope-access", run);
