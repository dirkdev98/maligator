import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const keys = Array.from({ length: 256 }, (_, index) => "dictionary-key-" + index);
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 80 * scale; round++) {
		const object = Object.create(null);
		for (let index = 0; index < keys.length; index++) {
			object[keys[index]] = index;
			operations++;
		}
		for (let index = 0; index < keys.length; index += 4) {
			delete object[keys[index]];
			operations++;
		}
		for (let index = 0; index < keys.length; index++) {
			const value = object[keys[index]];
			checksum += value === undefined ? 1 : value;
			object[keys[index]] = index + round;
			operations += 2;
		}
		let count = 0;
		for (const key of Object.keys(object)) {
			checksum += object[key] * ++count;
			operations++;
		}
		if (count !== keys.length) throw new Error("dictionary enumeration lost property");
	}
	return { checksum: checksum % 1000000007, operations };
}
runRuntimeGapCase("dictionary-operations", run);
