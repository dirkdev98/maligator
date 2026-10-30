import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/computed-function-names.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
const outDir = mkdtempSync(join(tmpdir(), "mal-computed-function-names-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each(["conservative", "precise"] as const)("%s roots", (nativeStackRoots) => {
	it.each(["mutable", "locked"] as const)(
		"preserves computed names and descriptors with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				outDir,
				name: `computed-function-names-${nativeStackRoots}-${primordials}`,
				nativeStackRoots,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			}
		},
	);
});
