import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-compact-heap-records-"));
const config = resolveBuildConfig({
	engine: { primordials: "mutable", eval: false, realms: false },
});

describe("materialized compact heap records", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		const options = {
			fixture: "tests/local/compact-heap-records.js",
			mainFile: "tests/fixtures/compact-heap-records/main.c",
			config,
			outDir,
		};
		compiled = buildNativeBinary({
			...options,
			name: "compact-heap-records",
			compiled: true,
		});
		interpreted = buildNativeBinary({
			...options,
			name: "compact-heap-records-ni",
			compiled: false,
		});
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	for (const backend of ["compiled", "interpreted"] as const) {
		it(`preserves retained identity, reflection, and generalization in ${backend}`, () => {
			const binary = backend === "compiled" ? compiled : interpreted;
			assertExactLines(
				runToStdout(binary, { env: { MAL_HOST_GC: "1" }, timeoutMs: 60_000 }),
				["compact-heap-records PASS"],
			);
		});

		it(`traces packed and generalized references under GC stress in ${backend}`, () => {
			const binary = backend === "compiled" ? compiled : interpreted;
			assertExactLines(
				runToStdout(binary, {
					env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
					timeoutMs: 60_000,
				}),
				["compact-heap-records PASS"],
			);
		});
	}
});
