import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 1000 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const source = { length: 32 };
		const values = Array.from(source, (_, index) => (index * 7 + round) & 255);
		if (!Array.isArray(values) || Array.isArray(source))
			throw new Error("array brand mismatch");
		let indexed = 0;
		let plain = 0;
		let entryPosition = 0;
		for (const [index, value] of values.entries()) {
			if (index !== entryPosition++ || value !== values[index])
				throw new Error("entry order mismatch");
			indexed += (index + 1) * value;
		}
		let position = 0;
		for (const value of values.values()) {
			if (value !== values[position]) throw new Error("value iterator order mismatch");
			plain += ++position * value;
		}
		if (indexed !== plain || position !== 32 || entryPosition !== 32)
			throw new Error("iterator contents mismatch");
		checksum += indexed + plain;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-construct-iterate", run);
