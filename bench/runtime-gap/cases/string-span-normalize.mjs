import { runRuntimeGapCase } from "../case-runner.mjs";
function normalizeField(source, form, escape) {
	const field = source.split("|")[1],
		token = field.trim(),
		output = token.normalize(form);
	if (escape) return token;
	return output;
}
function run(scale) {
	const values = [
		"id| café |end",
		"id| e\u0301 |end",
		"id| \ufb03 |end",
		"id| \u1100\u1161 |end",
	];
	const forms = ["NFC", "NFD", "NFKC", "NFKD"];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const output = normalizeField(
			values[i % values.length],
			forms[(i >> 2) & 3],
			(i & 63) === 0,
		);
		checksum =
			(checksum + output.length + output.charCodeAt(output.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-normalize", run);
