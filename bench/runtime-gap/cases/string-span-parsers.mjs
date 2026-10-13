import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(source, radix, escape) {
	const field = source.split("|")[1];
	const token = field.trim();
	const integer = Number.parseInt(token, radix);
	const fraction = parseFloat(token);
	if (escape) return token;
	return integer + fraction + token.length;
}
function run(scale) {
	const values = [
		"id| 12.5tail |end",
		"id| -0.5x |end",
		"id| 31e1x |end",
		"id| +42.25 |end",
	];
	const rounds = 160000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const value = classify(values[i % values.length], 10, (i & 63) === 0);
		checksum =
			(checksum + (typeof value === "string" ? value.length : value)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-parsers", run);
