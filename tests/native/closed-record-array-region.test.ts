import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/closed-record-array-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-closed-record-array-region-"));
const config = resolveBuildConfig({ engine: { primordials: "locked" } });

function run(binary: string, env: NodeJS.ProcessEnv = {}): void {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "closed-record-array-region");
}

describe("closed record-Array loop regions", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "closed-record-array-region",
			compiled: true,
			outDir,
			config,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "closed-record-array-region-ni",
			compiled: false,
			outDir,
			config,
		});
		concurrent = buildNativeBinary({
			fixture,
			name: "closed-record-array-region-concurrent",
			compiled: true,
			outDir,
			config,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
	}, 600_000);

	it("preserves compiled and interpreted behavior", () => {
		run(compiled);
		run(interpreted);
	});

	it("keeps private dense and record-slot proofs safe under GC stress", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
		run(concurrent, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	}, 120_000);
});
