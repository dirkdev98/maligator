import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(source, escape) {
	const field = source.split("|")[1];
	const token = field.trim();
	const head = token.substring(0, 4);
	if (escape) return token;
	return token.length + head.startsWith("12") + head.indexOf("2") + Number(token);
}
function run(scale) {
	const values = [
		"id| 12 |tail",
		"id|\t24\r|tail",
		"id|\ufeff36\u2029|tail",
		"id| 48 |tail",
		"id|60|tail",
		"id| 72\t|tail",
	];
	const rounds = 200000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const result = classify(values[i % values.length], (i & 63) === 0);
		checksum =
			(checksum + (typeof result === "number" ? result : result.length)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-trim-search", run);
