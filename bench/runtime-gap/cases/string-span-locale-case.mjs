import { runRuntimeGapCase } from "../case-runner.mjs";
function convertField(source, locale, escape) {
	const field = source.split("|")[1],
		token = field.trim(),
		lower = token.toLocaleLowerCase(locale),
		upper = token.toLocaleUpperCase(locale);
	if (escape) return token;
	return lower + upper;
}
function run(scale) {
	const values = ["id| Iİiı |end", "id| I\u0301 |end", "id| i\u0307 |end", "id| ΟΣ |end"],
		locales = ["en", "tr", "az", "lt"];
	const rounds = 100000 * scale;
	let checksum = 0;
	for (let i = 0; i < rounds; i++) {
		const output = convertField(
			values[i % values.length],
			locales[(i >> 2) & 3],
			(i & 63) === 0,
		);
		checksum =
			(checksum + output.length + output.charCodeAt(output.length - 1)) % 1000000007;
	}
	return { checksum, operations: rounds };
}
runRuntimeGapCase("string-span-locale-case", run);
