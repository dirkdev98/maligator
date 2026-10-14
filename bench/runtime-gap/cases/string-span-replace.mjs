import { runRuntimeGapCase } from "../case-runner.mjs";
function output(source, index, escape) {
	const field = source.split("|")[1];
	const token = field.trim();
	const out = index & 1 ? token.replaceAll("a", "xy") : token.replace("a", "[$&]");
	if (escape) return token;
	return out;
}
function run(scale) {
	const values = ["id| banana |end", "id| café |end", "id| 😀a |end", "id| aaab |end"];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const out = output(values[i % values.length], i, (i & 63) === 0);
		checksum = (checksum + out.length + out.charCodeAt(out.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-replace", run);
