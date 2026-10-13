import { runRuntimeGapCase } from "../case-runner.mjs";

function classify(source, start, end, escape) {
	const outer = source.slice(1, -1);
	const middle = outer.substring(start, end);
	const third = middle.slice(0, 4);
	const token = third.substring(0, 2);
	if (escape) return token;
	return token.length + token.codePointAt(0) + outer.length;
}

function run(scale) {
	const words = ["xifz", "x😀z", "x12z", "xreturnz", "xaz", "xwhilez"];
	let checksum = 0;
	const rounds = 200000 * scale;
	for (let index = 0; index < rounds; index++) {
		const result = classify(words[index % words.length], 0, 8, (index & 63) === 0);
		checksum =
			(checksum + (typeof result === "number" ? result : result.length)) % 1000000007;
	}
	return { checksum, operations: rounds };
}

runRuntimeGapCase("string-span-deep", run);
