import { runRuntimeGapCase } from "../case-runner.mjs";
function matches(source, expected) {
	const token = source.substring(1, source.length - 1);
	return token === expected ? token.length : 0;
}
function run(scale) {
	const sources = [],
		expected = [];
	for (let i = 0; i < 64; i++) {
		sources.push(`[token-${i % 16}]`);
		expected.push(`token-${i % 17}`);
	}
	const rounds = 800 * scale;
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		for (let i = 0; i < sources.length; i++) checksum += matches(sources[i], expected[i]);
	return { checksum, operations: rounds * sources.length };
}
runRuntimeGapCase("string-span-dynamic-token", run);
