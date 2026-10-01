import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const buffer = new ArrayBuffer(128);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const operations = 800 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const littleEndian = (round & 1) === 0;
		for (let index = 0; index < 32; index++)
			view.setUint32(index * 4, (index * 2654435761 + round) >>> 0, littleEndian);
		for (let index = 0; index < 4; index++) {
			const shift = (littleEndian ? index : 3 - index) * 8;
			if (bytes[index] !== ((round >>> shift) & 255))
				throw new Error("word byte order mismatch");
		}
		if (
			!ArrayBuffer.isView(view) ||
			!ArrayBuffer.isView(bytes) ||
			ArrayBuffer.isView(buffer)
		)
			throw new Error("buffer view brand mismatch");
		const copied = buffer.slice(16, 80);
		const copyView = new DataView(copied);
		for (let index = 0; index < 16; index++) {
			const value = copyView.getUint32(index * 4, littleEndian);
			const expected = ((index + 4) * 2654435761 + round) >>> 0;
			if (value !== expected) throw new Error("binary copy mismatch");
			checksum = (checksum + value) % 1000000007;
		}
	}
	return { checksum, operations };
}

runRuntimeGapCase("primordial-arraybuffer-word-copy", run);
