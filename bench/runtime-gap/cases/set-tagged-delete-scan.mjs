import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	let checksum = 0;
	let operations = 0;
	for (let domain = 0; domain < 3; domain++) {
		const keys = [];
		for (let index = 0; index < 4096; index++) {
			keys.push(
				domain === 0
					? index + 0.5
					: domain === 1
						? "tagged-delete-member-long-prefix-" + index
						: { index },
			);
		}
		for (let round = 0; round < 8 * scale; round++) {
			const set = new Set(keys);
			operations += keys.length;
			const pinned = (round & 1) === 0;
			const cursor = pinned ? set.values() : null;
			if (pinned && cursor.next().value !== keys[0])
				throw new Error("tagged cursor start mismatch");
			for (let index = 0; index < 3072; index++) {
				const slot = (index * 4051) & 4095;
				if (!set.delete(keys[slot])) throw new Error("tagged deletion missed member");
				checksum += slot;
				operations++;
			}
			let count = 0;
			for (const key of pinned ? cursor : set) {
				checksum += domain === 0 ? key : domain === 1 ? key.length : key.index;
				count++;
				operations++;
			}
			if (count !== 1024 || set.size !== 1024)
				throw new Error("tagged survivor scan mismatch");
			set.clear();
			if (set.size !== 0) throw new Error("tagged clear failed");
			operations++;
		}
	}
	return { checksum: checksum % 1_000_000_007, operations };
}

runRuntimeGapCase("set-tagged-delete-scan", run);
