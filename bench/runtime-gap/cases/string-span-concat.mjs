import { runRuntimeGapCase } from "../case-runner.mjs";
function output(source, index, escape) {
	const field = source.split("|")[1];
	const token = field.trim();
	const out = token.concat(":", index, "!");
	if (escape) return token;
	return out;
}
function run(scale) {
	const values = ["id| alpha |end", "id| café |end", "id| 😀 |end", "id| xyz |end"];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const out = output(values[i % values.length], i % 97, (i & 63) === 0);
		checksum = (checksum + out.length + out.charCodeAt(out.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-concat", run);
