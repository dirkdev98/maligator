import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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
			expect(run.stderr).toContain(
				"[perf-rest-stats] arrays=0 array_values=0 forwards=40 forwarded_values=90 forward_copies=0",
			);
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
