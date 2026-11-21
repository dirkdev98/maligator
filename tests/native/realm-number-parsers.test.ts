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

const fixture = "tests/local/realm-number-parsers.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-realm-number-parsers-"));
const pairs: Array<BackendPairResult> = [];
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
beforeAll(() => {
	for (const realms of [false, true])
		pairs.push(
			buildBackendPairFromOneProgramImage({
				fixture,
				name: `number-parsers-${realms}`,
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
				}),
			}),
		);
});

it.each([
	["parses primitive strings, radix boundaries and optional arguments", "values"],
	["preserves String then radix conversion order", "coercion"],
	["retains the selected parsers through argument getter mutation", "mutation"],
	["retains selected replacements through argument restoration", "restore"],
	["evaluates ignored arguments before dispatch", "extras"],
	["propagates ignored argument throws before conversion", "extra-throw"],
	["preserves method getter ordering and receiver identity", "accessor"],
	["retains abrupt primitive conversions", "symbols"],
	["respects local parser and namespace bindings", "shadow"],
	["keeps parsers nonconstructible", "construct"],
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
