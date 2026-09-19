import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Stepper {
	offset;
	constructor(offset) {
		this.offset = offset;
	}
	step(value) {
		return (value + this.offset) & 255;
	}
	run(value) {
		return this.step(value);
	}
}

const steppers = Array.from({ length: 32 }, (_, index) => new Stepper(seed + index));
const stepper = steppers[seed & 31];

function run(scale) {
	let checksum = 0;
	const operations = 1_000_000 * scale;
	for (let index = 0; index < operations; index++) {
		checksum = (checksum + stepper.run(index & 255)) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("public-method-call-known", run);
