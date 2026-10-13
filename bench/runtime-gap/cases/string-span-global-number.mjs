import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(source, escape) {
	const field = source.split("|")[1];
	const token = field.trim();
	const finite = isFinite(token),
		nan = isNaN(token);
	if (escape) return token;
	return (finite ? 1 : 0) + (nan ? 2 : 0);
}
function run(scale) {
	const values = [
		"id| 12.5 |end",
		"id| Infinity |end",
		"id| -3e2 |end",
		"id| NaN |end",
		"id| 0xff |end",
	];
	const rounds = 160000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const result = classify(values[i % values.length], (i & 63) === 0);
		checksum += typeof result === "string" ? result.length : result;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-global-number", run);
