import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/guarded-loop-versioning.mjs";
const parent = process.env.MAL_TEST_ARTIFACT_DIRECTORY ?? tmpdir();
mkdirSync(parent, { recursive: true });
const outDir = mkdtempSync(join(parent, "mal-guarded-loop-versioning-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("guarded numeric loop versions", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let precise: string;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "guarded-loop-versioning",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable" },
				surface: { node: true },
			}),
		});
		precise = buildNativeBinary({
			fixture,
			name: "guarded-loop-versioning-precise",
			outDir,
			nativeStackRoots: "precise",
			config: resolveBuildConfig({
				engine: { primordials: "mutable" },
				surface: { node: true },
			}),
		});
	});
	it.each([
		[
			"methodNumber",
			"continues at a replacement method without repeating earlier additions",
		],
		["methodString", "keeps string concatenation after a method guard fails"],
		["offset", "preserves a string returned by the guarded method"],
		["getter", "runs a getter once when its result leaves the numeric version"],
		["boundPatched", "selects the generic loop for a replaced bind method"],
		["bound", "keeps the bound receiver and arguments in the numeric version"],
		["callback", "observes mutable closure captures before a numeric bailout"],
		["cachedNumber", "preserves ToInt32 across scalar and boxed numeric conversions"],
	])("%s: %s", (scenario) => {
		const env = { GUARDED_LOOP_CASE: scenario, MAL_HOST_GC: "1" };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			env: { ...process.env, ...env },
			encoding: "utf8",
		});
		for (const binary of [pair.compiled, pair.interpreted, precise]) {
			expect(runToStdout(binary, { env })).toBe(expected);
			expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
		}
	});
});
