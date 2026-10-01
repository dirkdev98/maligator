import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 2200 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const first = 65 + (round % 26);
		const point = 0x1f600 + (round & 31);
		const prefix = String.fromCharCode(first, 0x300 + (round & 7));
		const suffix = String.fromCodePoint(point, 97 + (round % 26));
		const text = prefix + suffix;
		const at = text.at(-1);
		const char = text.charAt(round % text.length);
		const unit = text.charCodeAt(2);
		const codePoint = text.codePointAt(2);
		if (codePoint !== point || at.length !== 1 || unit < 0xd800 || unit > 0xdbff)
			throw new Error("Unicode indexing failed");
		checksum +=
			prefix.charCodeAt(0) +
			suffix.length +
			at.charCodeAt(0) +
			char.charCodeAt(0) +
			unit +
			codePoint;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-units-and-points", run);
