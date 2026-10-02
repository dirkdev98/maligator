import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 64 * scale; round++) {
		for (let group = 0; group < 64; group++) {
			const object = {};
			for (let member = 0; member < 4; member++) {
				const key = ["property", group, member, "x".repeat(32)].join("-");
				object[key] = round + member;
				operations++;
			}
			for (let member = 0; member < 4; member++) {
				const query = `property-${group}-${member}-${"x".repeat(32)}`;
				const value = object[query];
				if (value !== round + member) throw new Error("equal property name missing");
				checksum += value + query.length;
				operations++;
			}
		}
	}
	return { checksum: checksum % 1_000_000_007, operations };
}

runRuntimeGapCase("property-atom-reuse", run);
