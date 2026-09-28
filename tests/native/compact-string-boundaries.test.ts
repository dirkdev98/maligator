import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

describe("compact string runtime and host boundaries", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/compact-string-boundaries.mjs",
			name: "compact-string-boundaries",
			mainFile: "tests/fixtures/compact-string-boundaries/main.c",
			config: resolveBuildConfig({
				engine: { primordials: "mutable", regexp: false },
				surface: { webPlatform: true, node: true },
			}),
		});
	}, 600_000);

	it("keeps predicates and headers compact and reacquires iterator leaves across GC", () => {
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
			"compact-string-boundaries PASS\n",
		);
	});
});
