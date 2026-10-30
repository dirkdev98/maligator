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
const outDir = mkdtempSync(join(tmpdir(), "mal-function-prototype-apply-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const fixture = "tests/local/function-prototype-apply-sites.js";
const expected = execFileSync(
	process.execPath,
	[
		"--expose-gc",
		"-e",
		`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(fixture)},"utf8"));`,
	],
	{ encoding: "utf8" },
);
describe("guarded Function.prototype.apply literal calls", () => {
	it.each(["conservative", "precise"] as const)(
		"preserves dispatch, evaluation order, realms and heap arguments with %s roots",
		(nativeStackRoots) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				outDir,
				name: `function-prototype-apply-${nativeStackRoots}`,
				nativeStackRoots,
				entryGoal: "script",
				entryStrict: false,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: true },
				}),
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(
					runToStdout(binary, {
						env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...STRESS_ENV },
						timeoutMs: 60000,
					}),
				).toBe(expected);
			}
		},
	);
});
