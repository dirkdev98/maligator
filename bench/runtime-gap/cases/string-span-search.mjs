import { runRuntimeGapCase } from "../case-runner.mjs";

function classify(source, escape) {
	const outer = source.slice(1, -1);
	const token = outer.substring(0, 20);
	const found = token.indexOf("a");
	const contains = token.includes("a", 1);
	const starts = token.startsWith("a");
	const ends = token.endsWith("a");
	if (escape) return token;
	return found + contains + starts + ends + outer.length;
}

function run(scale) {
	const words = ["xabaz", "x😀az", "xalphaz", "xreturnz", "xbetaaz", "xwhilez"];
	let checksum = 0;
	const rounds = 200000 * scale;
	for (let index = 0; index < rounds; index++) {
		const result = classify(words[index % words.length], (index & 63) === 0);
		checksum =
			(checksum + (typeof result === "number" ? result : result.length)) % 1000000007;
	}
	return { checksum, operations: rounds };
}

runRuntimeGapCase("string-span-search", run);
