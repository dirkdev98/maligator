import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const values = Array.from({ length: 32 }, (_, index) => ({
		key: index & 7,
		serial: index,
	}));
	const operations = 1200 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const target = round % 10;
		const first = values.find((value) => value.key === target);
		const index = values.findIndex((value) => value.key === target);
		const last = values.findLast((value) => value.key === target);
		const some = values.some((value) => value.key === target);
		const every = values.every((value) => value.key < target);
		const hit = target < 8;
		if (
			some !== hit ||
			every !== target > 7 ||
			index !== (hit ? target : -1) ||
			first !== (hit ? values[target] : undefined) ||
			last !== (hit ? values[target + 24] : undefined)
		)
			throw new Error("predicate search mismatch");
		checksum +=
			index +
			(hit ? first.serial + last.serial : 17) +
			(some ? 31 : 0) +
			(every ? 43 : 0);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-array-predicate-search", run);
