import { runRuntimeGapCase } from "../case-runner.mjs";

function run(scale) {
	const target = { a: 1, b: 2, c: 3, d: 4 };
	let visits = 0;
	const proxy = new Proxy(target, {
		ownKeys() {
			visits++;
			return ["d", "c", "b", "a"];
		},
	});
	const operations = 30000 * scale;
	let checksum = 0;
	for (let i = 0; i < operations; i++) {
		const keys = Object.keys(proxy);
		checksum += keys.length + keys[i & 3].charCodeAt(0);
	}
	return { checksum: (checksum + visits) % 1000000007, operations };
}

runRuntimeGapCase("proxy-own-keys", run);
