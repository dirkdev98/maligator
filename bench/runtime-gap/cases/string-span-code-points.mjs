import { runRuntimeGapCase } from "../case-runner.mjs";

function classify(source, start, end, position, escape) {
	const token = source.substring(start, end);
	const point = token.codePointAt(position);
	if (escape) return token;
	if (point === undefined) return token.length;
	return point + token.length + token.charCodeAt(0);
}

function run(scale) {
	const words = ["if", "😀", "\ud800", "\udc00", "a𝄞", ""];
	let source = "";
	const starts = [],
		ends = [];
	for (let index = 0; index < 256; index++) {
		starts.push(source.length);
		source += words[index % words.length];
		ends.push(source.length);
		source += " ";
	}
	let checksum = 0;
	const rounds = 800 * scale;
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < starts.length; index++) {
			const result = classify(
				source,
				starts[index],
				ends[index],
				index % 3,
				(index & 63) === (round & 63),
			);
			checksum =
				(checksum + (typeof result === "string" ? result.length : result)) % 1000000007;
		}
	}
	return { checksum, operations: rounds * starts.length };
}

runRuntimeGapCase("string-span-code-points", run);
