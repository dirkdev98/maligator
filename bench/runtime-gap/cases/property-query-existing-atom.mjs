import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const names = Array.from({ length: 4 }, (_, i) => "property-query-missing-name-" + i);
	const stored = {};
	for (const name of names) {
		stored[name] = 1;
		delete stored[name];
	}
	const object = { marker: 1 };
	const operations = 180_000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		if (object[names[i & 3]] === undefined) checksum++;
	}
	return { checksum, operations };
}

runRuntimeGapCase("property-query-existing-atom", run, ({ checksum, operations }) => {
	if (checksum !== operations) throw new Error("existing atom query checksum mismatch");
});
