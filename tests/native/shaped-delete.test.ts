import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shaped-delete-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function dictionaryMigrations(binary: string, mode: string): number {
	const result = spawnSync(binary, [], {
		env: {
			...process.env,
			SHAPED_DELETE_MODE: mode,
			MAL_GC_STATS: "1",
			MAL_GC_AT_EXIT: "1",
		},
		encoding: "utf-8",
		timeout: 120_000,
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "shaped-delete");
	const migrations = result.stderr.match(/object_slot_dictionary_migrations=([0-9]+)/);
	expect(migrations, result.stderr).not.toBeNull();
	return Number(migrations![1]);
}

describe("deleting shaped properties", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/shaped-delete.js",
			entryGoal: "script",
			name: "shaped-delete",
			mainFile: HOST_MAIN,
			outDir,
			config: resolveBuildConfig({ surface: { node: true } }),
		}));
	}, 600_000);

	for (const backend of ["compiled", "interpreted"] as const) {
		for (const mode of ["shaped", "budget"]) {
			it(`preserves property semantics for ${mode} deletes in ${backend} mode`, () => {
				const binary = backend === "compiled" ? compiled : interpreted;
				for (const env of [{}, STRESS_ENV]) {
					assertPassLine(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", SHAPED_DELETE_MODE: mode, ...env },
							timeoutMs: 120_000,
						}),
						"shaped-delete",
					);
				}
			});
		}
	}

	it("keeps hundreds of deleted-from literals out of dictionary mode", () => {
		// The shaped mode deletes from over 700 coallocated objects.
		const baseline = dictionaryMigrations(compiled, "baseline");
		expect(dictionaryMigrations(compiled, "shaped") - baseline).toBeLessThan(200);
	});
});
