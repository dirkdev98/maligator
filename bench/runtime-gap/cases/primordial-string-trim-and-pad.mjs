import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1500 * scale;
	const prefix = " \t\u00a0";
	const suffix = "\u2003\n ";
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const value = "row" + (round & 255);
		const raw = prefix + value + suffix;
		const trimmed = raw.trim();
		const left = raw.trimStart();
		const right = raw.trimEnd();
		const startLength = 13 + (round & 1);
		const endLength = 14 + (round & 1);
		const start = trimmed.padStart(startLength, "ab");
		const end = trimmed.padEnd(endLength, "xy");
		if (trimmed !== value || left !== value + suffix || right !== prefix + value)
			throw new Error("whitespace trimming failed");
		if (start.length !== startLength || end.length !== endLength)
			throw new Error("padding length mismatch");
		const startPadding = startLength - value.length;
		for (let index = 0; index < startLength; index++) {
			const expected =
				index < startPadding ? "ab"[index & 1] : value[index - startPadding];
			if (start[index] !== expected) throw new Error("start padding mismatch");
			checksum += start.charCodeAt(index) * (index + 1);
		}
		for (let index = 0; index < endLength; index++) {
			const expected =
				index < value.length ? value[index] : "xy"[(index - value.length) & 1];
			if (end[index] !== expected) throw new Error("end padding mismatch");
			checksum += end.charCodeAt(index) * (index + 1);
		}
		for (const text of [trimmed, left, right]) {
			checksum += text.length;
			for (let index = 0; index < text.length; index++)
				checksum += text.charCodeAt(index) * (index + 1);
		}
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-string-trim-and-pad", run);
