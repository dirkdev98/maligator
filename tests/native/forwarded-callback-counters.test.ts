import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-forwarded-counters-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Keep this file in the plain native lane; sanitizers interpret the eval compiler.
describe("forwarded callback counter windows", () => {
	it.each([
		{
			scope: "generic",
			kind: "sort",
			fixture: "tests/local/forwarded-sort-callback.js",
			mode: "FORWARDED_SORT_KIND",
			realms: false,
			nominations: [0, 0],
		},
		{
			scope: "generic",
			kind: "from",
			fixture: "tests/local/forwarded-from-mapper.js",
			mode: "FROM_KIND",
			realms: false,
			nominations: [0, 0],
		},
		{
			scope: "cross-realm",
			kind: "sort",
			fixture: "tests/local/forwarded-sort-realms.js",
			mode: undefined,
			realms: true,
			nominations: [1, 1],
		},
		{
			scope: "cross-realm",
			kind: "from",
			fixture: "tests/local/forwarded-from-realms.js",
			mode: undefined,
			realms: true,
			nominations: [1, 1],
		},
	])(
		"excludes Function compilation from $scope $kind counters",
		({ scope, kind, fixture, mode, realms, nominations }) => {
			const environment = {
				...process.env,
				...(mode === undefined ? {} : { [mode]: "fallbacks" }),
				MAL_PERF_STATS: "1",
				MAL_PERF_CONTROL: "1",
				MAL_TEST262: realms ? "1" : undefined,
			};
			const expected = execFileSync(
				process.execPath,
				[
					"-e",
					`${
						realms
							? 'globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};'
							: ""
					}require("node:vm").runInThisContext(require("node:fs").readFileSync(process.argv[1], "utf8"), { filename: process.argv[1] });`,
					fixture,
				],
				{ encoding: "utf8", env: environment, timeout: 60_000 },
			);
			const binary = buildNativeBinary({
				fixture,
				name: `forwarded-counters-${scope}-${kind}`,
				entryGoal: "script",
				entryStrict: false,
				nodeEnabled: true,
				mainFile: realms ? "runtime/test262_main.c" : HOST_MAIN,
				outDir,
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const result = spawnSync(binary, [], {
				encoding: "utf8",
				env: environment,
				timeout: 60_000,
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe(expected);
			const counters = result.stderr.match(
				new RegExp(
					`\\[perf-${
						kind
					}-callback-stats\\] array_nominations=(\\d+) typed_nominations=(\\d+)`,
				),
			);
			if (counters === null) throw new Error(result.stderr);
			expect(counters.slice(1).map(Number)).toEqual(nominations);
		},
	);
});
