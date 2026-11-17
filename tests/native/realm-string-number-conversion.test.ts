import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const fixture = "tests/local/realm-string-number-conversion.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-realm-string-number-"));
const pairs: Array<BackendPairResult> = [];
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
beforeAll(() => {
	for (const realms of [false, true])
		pairs.push(
			buildBackendPairFromOneProgramImage({
				fixture,
				name: `string-number-conversion-${realms}`,
				outDir,
				nativeStackRoots: "precise",
				config: resolveBuildConfig({
					engine: {
						primordials: "mutable",
						realms,
						eval: false,
						regexp: false,
						temporal: false,
						intl: { enabled: false },
					},
					surface: { node: true, webPlatform: false },
				}),
			}),
		);
});
it.each([
	["formats primitive Number values", "values"],
	["finishes numeric coercion once before formatting", "coercion"],
	["retains String selected before argument mutation", "mutation"],
	["retains a replacement selected before argument restoration", "restore"],
	["finishes ignored arguments before formatting", "extras"],
	["preserves generic object and Symbol conversion", "generic"],
	["preserves String construction and local bindings", "construction"],
])("%s", (_label, mode) => {
	const env = { MAL_TEST_CASE: mode };
	const expected = execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	for (const pair of pairs)
		for (const binary of [pair.compiled, pair.interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
});
