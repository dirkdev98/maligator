import { readFileSync } from "node:fs";
import * as path from "node:path";

/** Eval runtimes that native global setup prepares only when a selected file needs them. */
export type NativePreparation =
	| "web-disabled"
	| "realms-disabled"
	| "perf-stats"
	| "node-perf-stats";

const perfManifests = new Map<string, ReadonlySet<string>>();

function perfTests(root: string): ReadonlySet<string> {
	let tests = perfManifests.get(root);
	if (tests === undefined) {
		tests = new Set(
			readFileSync(path.join(root, "tests/test-suite-native-perf.txt"), "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("#")),
		);
		perfManifests.set(root, tests);
	}
	return tests;
}

export function nativePreparations(root: string, file: string): Array<NativePreparation> {
	const relative = path
		.relative(root, path.resolve(root, file))
		.split(path.sep)
		.join("/");
	return [
		...(relative === "tests/native/web-disabled.test.ts"
			? (["web-disabled"] as const)
			: []),
		...(relative === "tests/native/realms-disabled.test.ts"
			? (["realms-disabled"] as const)
			: []),
		...(perfTests(root).has(relative) ? (["perf-stats"] as const) : []),
		...(relative === "tests/native/node-http-ready-queues.test.ts"
			? (["node-perf-stats"] as const)
			: []),
	];
}
