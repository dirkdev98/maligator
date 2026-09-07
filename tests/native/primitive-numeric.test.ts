import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/primitive-numeric.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();

describe("primitive numeric conversion through both emitters", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves coercion and numeric edges with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `primitive-numeric-${primordials}`,
				mainFile: HOST_MAIN,
				outDir: mkdtempSync(join(tmpdir(), "mal-primitive-numeric-")),
				config: resolveBuildConfig({
					engine: { primordials, eval: primordials === "mutable" },
				}),
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary).trim()).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 }).trim()).toBe(
					expected,
				);
			}
		},
		600_000,
	);
});
