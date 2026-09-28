import { runRuntimeGapCase } from "../case-runner.mjs";

const entries = [];
for (let index = 0; index < 2048; index++) {
	entries.push('"property-' + index + '":' + index);
}
const source = "{" + entries.join(",") + "}";

function run(scale) {
	let checksum = 0;
	const operations = 16 * scale;
	for (let batch = 0; batch < operations; batch++) {
		JSON.parse(source, (key, value, context) => {
			if (typeof value === "number") {
				checksum = (checksum + value + key.length + context.source.length) | 0;
			}
			return value;
		});
	}
	return { checksum: checksum >>> 0, operations: operations * 2048 };
}

runRuntimeGapCase("json-reviver-wide", run);
