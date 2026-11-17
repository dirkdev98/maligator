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

const fixture = "tests/local/realm-number-conversion.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-realm-number-conversion-"));
const pairs: Array<BackendPairResult> = [];
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
beforeAll(() => {
	for (const realms of [false, true])
		pairs.push(
			buildBackendPairFromOneProgramImage({
				fixture,
				name: `number-conversion-${realms}`,
				outDir,
				nativeStackRoots: "precise",
				config: resolveBuildConfig({
					engine: {
						primordials: "mutable",
						realms,
						eval: false,
						regexp: true,
						temporal: false,
						intl: { enabled: false },
					},
					surface: { node: true, webPlatform: false },
				}),
			}),
		);
});
it.each([
	["preserves String identity and effects for projected sources", "string-projections"],
	["converts complete String numeric syntax and ranges", "values"],
	["preserves object conversion order and abrupt completion", "coercion"],
	["retains the Number selected before argument mutation", "mutation"],
	["retains a replacement selected before argument restoration", "restore"],
	["preserves Number selection through slice reentry", "slice-mutation"],
	["finishes ignored arguments before dispatch and conversion", "extras"],
	["preserves numeric conversion from projected String sources", "projections"],
	["preserves wrapper construction, prototypes and local bindings", "construction"],
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
