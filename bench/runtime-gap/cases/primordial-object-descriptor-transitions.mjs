import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const operations = 500 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const record = { base: round & 255 };
		const installed = Object.defineProperty(record, "score", {
			value: round + 3,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		const completed = Object.defineProperties(record, {
			doubled: {
				get() {
					return this.base * 2;
				},
				enumerable: (round & 1) === 0,
			},
			hidden: { value: round + 9, enumerable: false },
		});
		record.score += 4;
		record.base += 1;
		const score = Object.getOwnPropertyDescriptor(record, "score");
		const descriptors = Object.getOwnPropertyDescriptors(record);
		if (
			installed !== record ||
			completed !== record ||
			score.value !== round + 7 ||
			!score.writable
		)
			throw new Error("descriptor update failed");
		checksum += score.value + descriptors.hidden.value + record.doubled;
		checksum += descriptors.doubled.enumerable ? 7 : 11;
		checksum += descriptors.doubled.get.call(record);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-object-descriptor-transitions", run);
