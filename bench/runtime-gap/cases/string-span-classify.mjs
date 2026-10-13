import { runRuntimeGapCase } from "../case-runner.mjs";

function classify(source, start, end, escape) {
	const token = source.slice(start, end);
	if (token.length === 2 && token === "if") return 3;
	if (token.length === 5 && token === "while") return 7;
	if (escape) return token;
	return token.length + Number(token);
}
function run(scale) {
	const words = ["if", "while", "120", "17.5", "-42", "12345"];
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
				(index & 63) === (round & 63),
			);
			checksum =
				(checksum + (typeof result === "string" ? result.length : result)) % 1000000007;
		}
	}
	return { checksum, operations: rounds * starts.length };
}
runRuntimeGapCase("string-span-classify", run);
