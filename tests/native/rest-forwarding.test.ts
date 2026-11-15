import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/rest-forwarding.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-rest-forwarding-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("rest argument forwarding", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let reference: string;
	beforeAll(() => {
		reference = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "rest-forwarding",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		});
	});
	for (const backend of ["compiled", "interpreted"] as const) {
		it(`${backend} matches Node for guarded forwarding and fallback`, () => {
			expect(runToStdout(pair[backend])).toBe(reference);
		});
		it(`${backend} retains argument references under GC stress`, () => {
			expect(runToStdout(pair[backend], { env: STRESS_ENV, timeoutMs: 60000 })).toBe(
				reference,
			);
		});
	}
});

describe("packed rest element reads", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let reference: string;
	beforeAll(() => {
		const packedFixture = "tests/local/rest-packed-reads.mjs";
		reference = execFileSync(process.execPath, [packedFixture], { encoding: "utf8" });
		pair = buildBackendPairFromOneProgramImage({
			fixture: packedFixture,
			name: "rest-packed-reads",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({ engine: { primordials: "locked" } }),
		});
	});
	for (const backend of ["compiled", "interpreted"] as const) {
		it(`${backend} preserves numeric index and payload semantics`, () => {
			expect(runToStdout(pair[backend], { env: STRESS_ENV, timeoutMs: 60000 })).toBe(
				reference,
			);
		});
	}
});

describe("rest forwarding allocation counters", () => {
	for (const primordials of ["mutable", "locked"] as const) {
		it(`${primordials} forwards without allocating a rest Array`, () => {
			const binary = buildNativeBinary({
				fixture: "tests/local/rest-forwarding-mechanism.mjs",
				name: `rest-forwarding-${primordials}-perf`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({ engine: { primordials } }),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const run = spawnSync(binary, [], {
				encoding: "utf8",
				env: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout.trim()).toBe("rest-forwarding-mechanism PASS");
			const stats = run.stderr.match(
				/^\[perf-rest-stats\] arrays=(\d+) array_values=(\d+) forwards=(\d+) forwarded_values=(\d+) forward_copies=(\d+)$/m,
			);
			expect(stats).not.toBeNull();
			expect(Number(stats![1])).toBe(0);
			expect(Number(stats![2])).toBe(0);
			expect(Number(stats![3])).toBeGreaterThan(0);
			expect(Number(stats![5])).toBeGreaterThan(0);
		});
	}
});

describe("rest forwarding realm fallbacks", () => {
	for (const compiled of [true, false]) {
		it(`${compiled ? "compiled" : "interpreted"} preserves foreign iterator and apply realms`, () => {
			const binary = buildNativeBinary({
				fixture: "tests/local/rest-forwarding-realms.js",
				name: `rest-forwarding-realms-${compiled}`,
				outDir,
				compiled,
				config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
			});
			expect(
				runToStdout(binary, {
					env: { ...STRESS_ENV, MAL_TEST262: "1" },
					timeoutMs: 60000,
				}).trim(),
			).toBe("rest-forwarding-realms PASS");
		});
	}
});

describe.each(["mutable", "locked"] as const)(
	"suspended rest forwarding under %s primordials",
	(primordials) => {
		let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
		beforeAll(() => {
			pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/rest-forwarding-suspended.mjs",
				name: `suspended-rest-${primordials}`,
				outDir,
				nativeStackRoots: "precise",
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
			});
		});
		for (const backend of ["compiled", "interpreted"] as const)
			it(`${backend} retains lazy and materialized lists across suspension`, () => {
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(pair[backend], { env: { ...stress, MAL_HOST_GC: "1" } }),
					).toBe("rest-forwarding-suspended PASS\n");
			});
		it("avoids rest Arrays in intact async and generator bodies", () => {
			const binary = buildNativeBinary({
				fixture: "tests/local/rest-forwarding-suspended-mechanism.mjs",
				name: `suspended-rest-mechanism-${primordials}`,
				outDir,
				nativeStackRoots: "precise",
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const result = spawnSync(binary, [], {
				encoding: "utf8",
				env: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("rest-forwarding-suspended-mechanism PASS");
			const counters = result.stderr.match(
				/^\[perf-rest-stats\] arrays=(\d+) array_values=(\d+) forwards=(\d+) forwarded_values=(\d+) forward_copies=(\d+)$/m,
			);
			expect(counters, result.stderr).not.toBeNull();
			expect(Number(counters![1])).toBe(0);
			expect(Number(counters![2])).toBe(0);
			expect(Number(counters![3])).toBeGreaterThan(0);
		});
	},
);
