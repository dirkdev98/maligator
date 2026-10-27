import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildNativeBinary,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = "true Out of memory\nobject true\ntrue Out of memory\n";

describe("recoverable allocation failure", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("catches one-shot CELL failure in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/allocation_failure.js",
			name: `allocation-failure-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(
			runToStdout(binary, {
				env: { MAL_ALLOC_FAIL_TEST: "1", MAL_GC_AT_EXIT: "1" },
			}),
		).toBe(expected);
	});

	it("catches allocation failures after property forwarding and dead-result cleanup", () => {
		const directory = mkdtempSync(join(tmpdir(), "mal-dead-allocation-handler-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/dead-allocation-handler.mjs",
				name: "dead-allocation-handler",
				mainFile: HOST_MAIN,
				outDir: directory,
				config: resolveBuildConfig({
					engine: { eval: false, realms: false },
					surface: { node: true },
				}),
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				for (const stress of [{}, STRESS_ENV]) {
					expect(
						runToStdout(binary, {
							env: { ...stress, MAL_ALLOC_FAIL_TEST: "1", MAL_GC_AT_EXIT: "1" },
						}),
					).toBe("true Out of memory\n42\ntrue Out of memory\n");
				}
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
