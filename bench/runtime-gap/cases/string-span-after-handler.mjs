import { runRuntimeGapCase } from "../case-runner.mjs";
function check(index) {
	if ((index & 63) === 1) throw index;
	return index;
}
function classify(source, index, observe) {
	try {
		observe(index);
	} catch (error) {
		return error;
	}
	const part = source.split("|")[1];
	if ((index & 127) === 0) return part;
	return part.length + part.indexOf("a");
}
function run(scale) {
	const words = ["x|alpha|z", "x|😀a|z", "x|beta|z", "x|gamma|z"];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let index = 0; index < rounds; index++) {
		const result = classify(words[index & 3], index, check);
		checksum =
			(checksum + (typeof result === "number" ? result : result.length)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-after-handler", run);
