import { runRuntimeGapCase } from "../case-runner.mjs";

function classify(source, start, end, escape) {
	const parent = source.slice(1, -1);
	const token = parent.substring(start, end);
	const size = token.length;
	if (escape) return token;
	return size + token.codePointAt(0) + parent.length;
}

function run(scale) {
	const words = ["xifz", "x😀z", "x12z", "xreturnz", "xaz", "xwhilez"];
	let checksum = 0;
	const rounds = 200000 * scale;
	for (let index = 0; index < rounds; index++) {
		const result = classify(words[index % words.length], 0, 2, (index & 63) === 0);
		checksum =
			(checksum + (typeof result === "string" ? result.length : result)) % 1000000007;
	}
	return { checksum, operations: rounds };
}

runRuntimeGapCase("string-span-nested", run);
