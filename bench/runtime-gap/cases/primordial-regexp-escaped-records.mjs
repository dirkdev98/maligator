import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 400 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const token = "a+b." + (round & 15);
		const escaped = RegExp.escape(token);
		const pattern = new RegExp("^" + escaped + ":(\\d+)$", "g");
		const subject = token + ":" + (round & 255);
		const matched = pattern.exec(subject);
		if (
			matched === null ||
			Number(matched[1]) !== (round & 255) ||
			pattern.lastIndex !== subject.length
		)
			throw new Error("regexp capture failed");
		checksum +=
			Number(matched[1]) + matched[0].length + pattern.lastIndex + escaped.length;
		pattern.lastIndex = 0;
		const present = pattern.test(round & 1 ? subject : subject + "!");
		if (present !== ((round & 1) === 1)) throw new Error("regexp test failed");
		checksum += present ? pattern.lastIndex + 7 : 11;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-regexp-escaped-records", run);
