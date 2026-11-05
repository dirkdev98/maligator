import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const directory = mkdtempSync(join(tmpdir(), "mal-json-shapes-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/json-parse-shapes.js",
		name: "json-parse-shapes",
		outDir: directory,
		mainFile: HOST_MAIN,
		environment: { ...process.env, MAL_PERF_STATS: "1" },
		config: resolveBuildConfig({
			engine: {
				eval: false,
				realms: false,
				regexp: false,
				intl: { enabled: false },
			},
			surface: { node: false, webPlatform: false },
		}),
	});
});

it.each(["compiled", "interpreted"] as const)(
	"reuses alternating record layouts without stale keys or values in %s mode",
	(backend) => {
		const invocation = resolveHarnessExecutionInvocation(pair[backend]);
		const result = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				...STRESS_ENV,
				MAL_HOST_GC: "1",
				MAL_PERF_STATS: "1",
			},
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const { expectedMemoHits } = JSON.parse(result.stdout) as {
			expectedMemoHits: number;
		};
		expect(expectedMemoHits).toBeGreaterThan(0);
		const hits = result.stderr.match(/(?:^|\s)parse_shape_memo_hits=([0-9]+)/);
		expect(hits, result.stderr).not.toBeNull();
		expect(Number(hits![1])).toBeGreaterThanOrEqual(expectedMemoHits);
	},
);
