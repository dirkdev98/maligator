import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 16 * scale; round++) {
		const map = new Map();
		for (let index = 0; index < 8192; index++) {
			map.set(index, index ^ round);
			operations++;
		}
		const cursor = map.entries();
		const first = cursor.next();
		if (first.done || first.value[0] !== 0 || first.value[1] !== round)
			throw new Error("numeric cursor start mismatch");
		checksum += first.value[1];
		for (let index = 0; index < 8192; index++) {
			const key = (index * 4051) & 8191;
			if (!map.delete(key)) throw new Error("numeric deletion missed key");
			checksum += key;
			operations++;
		}
		if (map.size !== 0 || !cursor.next().done)
			throw new Error("deleted numeric entries remain visible");
	}
	return { checksum: checksum % 1_000_000_007, operations };
}

runRuntimeGapCase("map-numeric-delete-pinned", run);
