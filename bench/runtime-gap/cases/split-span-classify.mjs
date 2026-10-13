import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(source, escape) {
	const part = source.split("|")[1];
	const size = part.length;
	if (part === "if") return size + 10;
	if (escape) return observe(part);
	return size;
}
function observe(part) {
	return part.length + part.charCodeAt(0);
}
function run(scale) {
	const sources = ["keyword|if|1", "keyword|else|2", "name|value|3", "space||4"];
	let checksum = 0;
	const rounds = 30000 * scale;
	for (let index = 0; index < rounds; index++)
		checksum += classify(sources[index % 4], index % 1024 === 1);
	return { checksum, operations: rounds };
}
runRuntimeGapCase("split-span-classify", run);
