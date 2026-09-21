import { runRuntimeGapCase } from "../case-runner.mjs";

const seed = Number(process.argv[2] ?? "1") & 255;

class Record {
	constructor(value, returned) {
		this.value = value;
		return returned;
	}
}

const returned = Array.from({ length: 256 }, (_, index) =>
	index & 1 ? { value: (seed + index) & 255 } : index,
);
const retained = new Array(256);

function run(scale) {
	let checksum = 0;
	const operations = 50_000 * scale;
	for (let index = 0; index < operations; index++) {
		const selected = index & 255;
		const record = new Record((seed + index) & 255, returned[selected]);
		retained[selected] = record;
		checksum = (checksum + record.value) | 0;
	}
	return { checksum: checksum >>> 0, operations };
}

function verify() {
	for (let index = 0; index < retained.length; index++) {
		const record = retained[index];
		if (index & 1 ? record !== returned[index] : !(record instanceof Record)) {
			throw new Error("dynamic constructor return selection differs");
		}
	}
}

runRuntimeGapCase("constructor-return-selected-retained", run, verify);
