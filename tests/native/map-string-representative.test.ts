import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/map-string-representative.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-map-string-representative-"));

describe("Map primitive string representatives", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	let ownership: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
		});
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "map-string-representative",
			outDir,
		}));
		ownership = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "map-string-representative-ownership",
			mainFile: "tests/fixtures/map-string-representative/main.c",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("matches Node across updates, old-key reads, live iterators, clear, and collection", () => {
		const env = { MAL_HOST_GC: "1" };
		expect(runToStdout(compiled, { env })).toBe(expected);
		expect(runToStdout(interpreted, { env })).toBe(expected);
	});

	it("preserves all key domains and representative reachability under GC stress", () => {
		const env = { ...STRESS_ENV, MAL_HOST_GC: "1" };
		expect(runToStdout(compiled, { env })).toBe(expected);
		expect(runToStdout(interpreted, { env })).toBe(expected);
	});

	it("eliminates repeated equal-query comparisons while bounding retained backing", () => {
		const env = {
			MAL_GC_STRESS: "0",
			MAL_GC_VERIFY: "1",
			MAL_GC_MAJOR_EVERY: "8",
			MAL_PERF_STATS: "1",
		};
		const output = runToStdout(ownership, { env });
		expect(output).toContain(
			"checksum=18432 repeated_units=0 old_key_units=4096 young_key=live",
		);
		expect(output).toContain("capacities=1024,32785");
		expect(output).toContain("map-string-representative PASS\n");
	});

	it("keeps a replaced key in the incremental snapshot until the following collection", () => {
		const invocation = resolveHarnessExecutionInvocation(ownership);
		const env = {
			...process.env,
			MAL_GC_STRESS: "0",
			MAL_GC_VERIFY: "1",
			MAL_PERF_STATS: "1",
		};
		const output = execFileSync(invocation.executable, [...invocation.args, "satb"], {
			env,
			encoding: "utf8",
			timeout: scaledNativeRunTimeoutMs(20_000, env),
		});
		expect(output).toContain("replaced key survives snapshot then is reclaimed");
		expect(output).toContain("map-string-representative PASS\n");
	});
});
