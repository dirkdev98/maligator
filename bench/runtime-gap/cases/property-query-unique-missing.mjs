import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const object = { marker: 1 };
	const operations = 180_000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const name = "property-query-missing-name-" + i;
		if (object[name] === undefined) checksum++;
	}
	return { checksum, operations };
}

runRuntimeGapCase("property-query-unique-missing", run, ({ checksum, operations }) => {
	if (checksum !== operations) throw new Error("unique query checksum mismatch");
});
