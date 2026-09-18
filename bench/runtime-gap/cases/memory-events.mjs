import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function memoryEventReplay(scale) {
	const instructions = Array.from({ length: 40_000 }, (_, index) => ({
		id: index,
		operation: index % 7 === 0 ? "store" : index % 5 === 0 ? "load" : "pure",
		location: index & 511,
	}));
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 35 * scale; round++) {
		const events = [];
		for (const instruction of instructions) {
			if (instruction.operation !== "pure")
				events.push(instruction.id, instruction.location);
			operations++;
		}
		for (const event of events) checksum = (checksum + event) % MODULUS;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("memory-events", memoryEventReplay);
