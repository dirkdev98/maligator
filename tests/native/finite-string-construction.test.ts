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

const fixture = "tests/local/finite-string-construction.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-finite-string-construction-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let locked: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let mutable: ReturnType<typeof buildBackendPairFromOneProgramImage>;

function expected(scenario: string) {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, FINITE_STRING_CASE: scenario },
	});
}

beforeAll(() => {
	const build = (primordials: "locked" | "mutable") =>
		buildBackendPairFromOneProgramImage({
			fixture,
			name: `finite-string-${primordials}`,
			outDir,
			config: resolveBuildConfig({
				engine: { eval: false, realms: false, primordials },
				surface: { node: true },
			}),
		});
	locked = build("locked");
	mutable = build("mutable");
});

it.each([
	["converts bounded integral Number results", "values"],
	["preserves branch-refined and loop-carried ranges", "ranges"],
	["converts integral ranges crossing the signed 32-bit boundary", "large"],
	["retains complete UTF-16 prefix and suffix units", "unicode"],
	["coerces the numeric expression exactly once", "coercion"],
	["preserves mixed BigInt and Symbol failures", "throws"],
	["retains fractional, unbounded and handled construction", "fallbacks"],
	["passes selected strings through callback calls", "callbacks"],
])("%s", (_name, scenario) => {
	const output = expected(scenario);
	for (const pair of [locked, mutable])
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: { FINITE_STRING_CASE: scenario } })).toBe(output);
});

it("retains selected strings through collection", () => {
	const output = expected("gc");
	for (const binary of [locked.compiled, locked.interpreted])
		expect(
			runToStdout(binary, {
				env: { ...STRESS_ENV, MAL_HOST_GC: "1", FINITE_STRING_CASE: "gc" },
			}),
		).toBe(output);
});

it("uses abstract Number conversion with replaced globals and prototypes", () => {
	const output = expected("mutable");
	for (const binary of [mutable.compiled, mutable.interpreted])
		expect(runToStdout(binary, { env: { FINITE_STRING_CASE: "mutable" } })).toBe(output);
});
