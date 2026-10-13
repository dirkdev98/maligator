import { runRuntimeGapCase } from "../case-runner.mjs";
function expand(source, target, escape) {
	const field = source.split("|")[1];
	const token = field.trim();
	const output = token.padStart(target, "0").padEnd(target + 3, "_");
	if (escape) return token;
	return output;
}
function run(scale) {
	const values = ["id| ab |end", "id| café |end", "id| 😀 |end", "id| xyz |end"];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const result = expand(values[i % values.length], (i % 4) + 8, (i & 63) === 0);
		checksum =
			(checksum + result.length + result.charCodeAt(result.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-pad", run);
