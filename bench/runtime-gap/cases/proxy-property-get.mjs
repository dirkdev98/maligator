import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const target = { x: 11, y: 23 };
	let gets = 0;
	const proxy = new Proxy(target, {
		get(object, key) {
			gets++;
			return object[key];
		},
	});
	const operations = 200000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		target.x = i & 255;
		checksum += proxy[i & 1 ? "x" : "y"];
	}
	return { checksum: (checksum + gets) % 1000000007, operations };
}

runRuntimeGapCase("proxy-property-get", run);
