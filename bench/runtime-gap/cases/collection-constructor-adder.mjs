import { runRuntimeGapCase } from "../case-runner.mjs";
function run(scale) {
	const factor = 3;
	class ScaledMap extends Map {
		set(key, value) {
			return super.set(key, value * factor);
		}
	}
	const source = new Map();
	for (let index = 0; index < 128; index++) source.set(index, index + 1);
	let checksum = 0;
	const rounds = 500 * scale;
	for (let round = 0; round < rounds; round++) {
		const result = new ScaledMap(source.entries());
		checksum += result.size + result.get(round & 127);
	}
	return { checksum, operations: rounds * source.size };
}
runRuntimeGapCase("collection-constructor-adder", run);
