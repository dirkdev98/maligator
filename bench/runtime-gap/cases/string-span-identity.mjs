import { runRuntimeGapCase } from "../case-runner.mjs";
function token(source) {
	const parent = source.split("|")[1];
	const part = parent.toString().valueOf();
	return part.length + part.charCodeAt(0) + part.charCodeAt(part.length - 1);
}
function run(scale) {
	const rows = ["|alpha|", "|beta|", "|gamma|", "|delta|"];
	let checksum = 0;
	const operations = 100000 * scale;
	for (let i = 0; i < operations; i++) checksum += token(rows[i % 4]);
	return { checksum, operations };
}
runRuntimeGapCase("string-span-identity", run);
