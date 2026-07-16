import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-object-slot-coallocation-"));

describe("one-slot shaped object coallocation", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/object_slot_coallocation.js",
			name: "object-slot-coallocation",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/object_slot_coallocation.js",
			name: "object-slot-coallocation-ni",
			compiled: false,
			outDir,
		});
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	])("preserves growth and dictionary transitions in %s mode", (_name, binary) => {
		assertPassLine(runToStdout(binary()), "object-slot-coallocation");
		assertPassLine(
			runToStdout(binary(), {
				env: { ...STRESS_ENV, MAL_GC_AT_EXIT: "1" },
				timeoutMs: 60000,
			}),
			"object-slot-coallocation",
		);
	});

	it("reports coallocations and both migration paths", () => {
		const result = spawnSync(interpreted, [], {
			env: { ...process.env, MAL_GC_STATS: "1", MAL_GC_AT_EXIT: "1" },
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		assertPassLine(result.stdout, "object-slot-coallocation");
		const field = (name: string): number =>
			Number(result.stderr.match(new RegExp(`${name}=([0-9]+)`))?.[1] ?? 0);
		expect(field("object_slot_coallocations")).toBeGreaterThanOrEqual(2008);
		expect(field("object_slot_grow_migrations")).toBeGreaterThanOrEqual(1);
		expect(field("object_slot_dictionary_migrations")).toBeGreaterThanOrEqual(5);
	});
});
