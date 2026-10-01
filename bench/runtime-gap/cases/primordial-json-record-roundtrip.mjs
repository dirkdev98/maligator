import { runRuntimeGapCase } from "../case-runner.mjs";

const labels = ["plain", 'quote"slash\\', "café\nline", "東京\tfield"];

function run(scale) {
	const operations = 600 * scale;
	let checksum = 0;
	for (let round = 0; round < operations; round++) {
		const record = {
			id: round,
			active: (round & 1) === 0,
			values: [round & 31, (round * 7) & 255, -(round & 15)],
			nested: { label: labels[round & 3], count: round % 17 },
		};
		const text = JSON.stringify(record);
		const parsed = JSON.parse(text);
		if (
			parsed.id !== round ||
			parsed.active !== record.active ||
			parsed.nested.label !== record.nested.label ||
			parsed.values.length !== 3 ||
			parsed.nested.count !== record.nested.count
		)
			throw new Error("JSON record mismatch");
		for (let index = 0; index < text.length; index++)
			checksum += text.charCodeAt(index) * (index + 1);
		for (let index = 0; index < 3; index++) {
			if (parsed.values[index] !== record.values[index])
				throw new Error("JSON value mismatch");
			checksum += parsed.values[index];
		}
		checksum += parsed.id + parsed.nested.count + (parsed.active ? 1 : 0);
	}
	return { checksum: checksum % 1000000007, operations };
}

runRuntimeGapCase("primordial-json-record-roundtrip", run);
