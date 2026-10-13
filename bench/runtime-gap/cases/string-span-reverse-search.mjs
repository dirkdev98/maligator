import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(source, escape) {
	const field = source.split("|")[1];
	const trimmed = field.trim();
	const token = trimmed.substr(1, 5);
	const delimiter = token.lastIndexOf(":");
	if (escape) return token;
	return delimiter + token.length + token.charCodeAt(0) + trimmed.length;
}
function run(scale) {
	const values = [
		"id| x1:23 |tail",
		"id|\tx22:3\r|tail",
		"id| x333: |tail",
		"id| x4444 |tail",
		"id| x:555 |tail",
		"id| x6666: |tail",
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
runRuntimeGapCase("string-span-reverse-search", run);
