import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-private-shaped-"));
const fixture = "tests/local/private-shaped.js";

describe("private-name overflow with public shapes", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "private-shaped",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "private-shaped-ni",
			compiled: false,
			outDir,
		});
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	])("preserves public and private storage semantics in %s mode", (_name, binary) => {
		expect(runToStdout(binary())).toBe("private-shaped PASS\n");
		expect(runToStdout(binary(), { env: STRESS_ENV })).toBe("private-shaped PASS\n");
	});

	it("keeps private-only overflow out of public dictionary storage", () => {
		const result = spawnSync(interpreted, [], {
			env: { ...process.env, MAL_GC_STATS: "1", MAL_GC_AT_EXIT: "1" },
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("private-shaped PASS\n");
		const migrations = Number(
			result.stderr.match(/object_slot_dictionary_migrations=([0-9]+)/)?.[1] ?? -1,
		);
		expect(migrations).toBeLessThan(100);
	});
});
