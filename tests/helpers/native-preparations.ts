import { readFileSync } from "node:fs";
import * as path from "node:path";

/** Eval runtimes that native global setup prepares only when a selected file needs them. */
export type NativePreparation =
	| "realms-disabled"
	| "perf-stats"
	| "locked-perf-stats"
	| "product-eval-defaults"
	| "owning-argument-forwarding";

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
		...(relative === "tests/native/realms-disabled.test.ts"
			? (["realms-disabled"] as const)
			: []),
		...(perfTests(root).has(relative) ? (["perf-stats"] as const) : []),
		...(relative === "tests/native/arguments-alias.test.ts" ||
		relative === "tests/native/arguments-forwarding.test.ts" ||
		relative === "tests/native/arguments-element-reads.test.ts" ||
		relative === "tests/native/arguments-slice-copy.test.ts" ||
		relative === "tests/native/exact-collection-capture.test.ts"
			? (["locked-perf-stats"] as const)
			: []),
		// Its product build config must keep resolving to `defaultProductEvalConfig()`.
		...(relative === "tests/native/express-valibot-build.test.ts"
			? (["product-eval-defaults"] as const)
			: []),
		...(relative === "tests/native/owning-argument-forwarding.test.ts"
			? (["owning-argument-forwarding"] as const)
			: []),
	];
}
