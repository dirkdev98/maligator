import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-object-accessor-tail-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/object-accessor-tail.mjs",
		name: "object-accessor-tail",
		mainFile: HOST_MAIN,
		outDir,
	});
});

for (const backend of ["compiled", "interpreted"] as const) {
	it.each([
		["order", "enumerates data fields and appended getters in insertion order"],
		["conversion", "preserves order and setters when an existing field changes kind"],
		["deletion", "places deleted and re-added fields after surviving properties"],
		["emptyPrefix", "defines derived fields after deleting every original field"],
		["integrity", "honors descriptor and integrity restrictions"],
		["caches", "observes own and inherited changes after cached reads"],
		["keys", "orders integer and symbol keys across storage changes"],
		["privateFields", "retains private fields through growth and freezing"],
		["reentry", "observes getter mutations during enumeration and collection"],
	])(`%s: %s in ${backend} code`, (name) => {
		for (const env of [{}, STRESS_ENV]) {
			expect(
				runToStdout(binaries[backend], {
					env: { MAL_HOST_GC: "1", OBJECT_ACCESSOR_TAIL_CASE: name, ...env },
				}),
			).toBe(`PASS ${name}\n`);
		}
	});
}
it("retains coallocated data fields when only accessors are appended", () => {
	const count = 64;
	const invocation = resolveHarnessExecutionInvocation(binaries.interpreted);
	const runs = ["1", "0"].map((control) => {
		const result = spawnSync(invocation.executable, invocation.args, {
			env: {
				...process.env,
				MAL_GC_STATS: "1",
				MAL_GC_AT_EXIT: "1",
				OBJECT_ACCESSOR_TAIL_CASE: "allocation",
				OBJECT_ACCESSOR_TAIL_CONTROL: control,
				OBJECT_ACCESSOR_TAIL_COUNT: String(count),
			},
			encoding: "utf8",
			timeout: 20000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("PASS allocation\n");
		const field = (name: string) => {
			const match = result.stderr.match(new RegExp(`${name}=([0-9]+)`));
			expect(match, result.stderr).not.toBeNull();
			return Number(match![1]);
		};
		expect(field("object_slot_coallocations")).toBeGreaterThanOrEqual(count);
		return field("object_slot_dictionary_migrations");
	});
	expect(runs[1]! - runs[0]!).toBeLessThan(count / 8);
});
