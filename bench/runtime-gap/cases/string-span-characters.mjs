import { runRuntimeGapCase } from "../case-runner.mjs";

function classify(source, start, end, escape) {
	const token = source.substring(start, end);
	const first = token.charAt(0);
	const last = token.at(-1);
	if (escape) return token;
	return first + (last === undefined ? "" : last);
}

function run(scale) {
	const words = ["xifz", "x😀z", "x12z", "xreturnz", "x\ud800z", "xz"];
	let checksum = 0;
	const rounds = 200000 * scale;
	for (let index = 0; index < rounds; index++) {
		const source = words[index % words.length];
		const result = classify(source, 1, source.length - 1, (index & 63) === 0);
		checksum = (checksum + result.length + (result.charCodeAt(0) || 0)) % 1000000007;
	}
	return { checksum, operations: rounds };
}

runRuntimeGapCase("string-span-characters", run);
