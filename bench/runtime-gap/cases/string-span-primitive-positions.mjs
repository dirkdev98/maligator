import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(source, position) {
	const parent = source.slice("1", "-1");
	const part = parent.substring(false, "6");
	return part.charCodeAt(position) + part.lastIndexOf("a", position) + part.length;
}
function run(scale) {
	let checksum = 0;
	const rounds = 60000 * scale;
	const positions = [null, false, true, "0", "1", "2"];
	for (let i = 0; i < rounds; i++)
		checksum = (checksum + classify("[ababa]", positions[i % positions.length])) | 0;
	return { checksum: checksum >>> 0, operations: rounds };
}
runRuntimeGapCase("string-span-primitive-positions", run);
