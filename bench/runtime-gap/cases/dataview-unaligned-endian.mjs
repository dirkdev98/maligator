import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const view = new DataView(new ArrayBuffer(1032));
	const operations = 300000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const offset = (i & 255) * 4 + 1;
		const little = (i & 1) === 0;
		view.setUint32(offset, i ^ 0x12345678, little);
		checksum += view.getUint32(offset, !little) & 65535;
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("dataview-unaligned-endian", run);
