import { runRuntimeGapCase } from "../case-runner.mjs";
function compareField(source, that) {
	const part = String(source).slice(1, -1).trim();
	return part.localeCompare(that, "en");
}
runRuntimeGapCase("string-span-locale-compare", (iterations) => {
	const values = ["|alpha|", "| beta |", "|café|", "|delta|"];
	let checksum = 0;
	const operations = iterations * 40000;
	for (let i = 0; i < operations; i++)
		checksum = (checksum + Math.sign(compareField(values[i & 3], "beta")) + 2) | 0;
	return { checksum, operations };
});
