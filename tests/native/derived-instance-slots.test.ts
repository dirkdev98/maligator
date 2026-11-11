import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertExactLines, buildNativeBinary } from "../../src/test-harness.ts";

const fixture = "tests/local/derived-instance-slots.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-derived-instance-slots-"));

function slotGrowth(binary: string): number {
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_HOST_GC: "1", MAL_GC_STATS: "1", MAL_GC_AT_EXIT: "1" },
		encoding: "utf-8",
	});
	expect(result.status, result.stderr).toBe(0);
	assertExactLines(result.stdout, ["derived-instance-slots PASS"]);
	return Number(result.stderr.match(/object_slot_grow_migrations=([0-9]+)/)?.[1] ?? -1);
}

describe("instances a subclass constructs", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "derived-instance-slots",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "derived-instance-slots-ni",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	])(
		"keep subclass fields in the slots the base constructor reserved in %s mode",
		(_mode, binary) => {
			const growth = slotGrowth(binary());
			expect(growth).toBeGreaterThanOrEqual(0);
			// The fixture builds 4000 subclass instances; only the prototype swaps may grow.
			expect(growth).toBeLessThan(40);
		},
	);
});
