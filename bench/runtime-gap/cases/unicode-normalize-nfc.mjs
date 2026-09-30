import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = ["café", "Å̧", "각", "𝄞 é ñ"];
	const operations = 30000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const value = values[i & 3].normalize("NFC");
		checksum += value.length + value.charCodeAt(value.length - 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("unicode-normalize-nfc", run);
