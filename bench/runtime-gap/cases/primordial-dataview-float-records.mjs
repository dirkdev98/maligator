import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const buffer = new ArrayBuffer(80);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const operations = 1200 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		for (let index = 0; index < 8; index++) {
			const value = ((round & 31) - 16) * 0.125 + index * 1.5;
			const littleEndian = ((round + index) & 1) === 0;
			view.setFloat64(index * 9, value, littleEndian);
			const read = view.getFloat64(index * 9, littleEndian);
			if (read !== value) throw new Error("float record mismatch");
			checksum += read * 8;
		}
		for (let index = 0; index < bytes.length; index++)
			checksum += bytes[index] * (index + 1);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-dataview-float-records", run);
