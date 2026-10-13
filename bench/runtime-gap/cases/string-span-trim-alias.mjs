import { runRuntimeGapCase } from "../case-runner.mjs";
function classify(line, escape) {
	const body = line.slice(1, -1);
	const leading = body.trimLeft();
	const token = leading.trimRight();
	if (escape) return token;
	return token.length + token.charCodeAt(0) + token.indexOf(":") + body.length;
}
function run(scale) {
	const lines = [
		"|  Host: example.com\r\n|",
		"|\tAccept: */*  |",
		"|\ufeffX-Tag: 😀\u2029|",
		"| User: 123 |",
	];
	const rounds = 160000 * scale;
	let checksum = 0;
	for (let index = 0; index < rounds; index++) {
		const result = classify(lines[index % lines.length], (index & 63) === 0);
		checksum =
			(checksum + (typeof result === "number" ? result : result.length)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-trim-alias", run);
