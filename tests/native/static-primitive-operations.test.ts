import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("primitive operation differential", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves values and coercion order with %s primordials",
		(primordials) => {
			const fixture = "tests/local/static-primitive-operations.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-primitives-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitives",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
