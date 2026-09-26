import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-lifecycle-"));

describe("collector lifecycle", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/gc-lifecycle.js",
			name: "gc-lifecycle",
			mainFile: "tests/fixtures/gc-lifecycle/main.c",
			outDir,
		});
	});

	it("abandons mark and sweep with a suspended generator before VM teardown", () => {
		expect(
			runToStdout(binary, {
				env: { MAL_GC_THRESHOLD: "1", MAL_GC_MAJOR_EVERY: "1", MAL_GC_VERIFY: "1" },
			}),
		).toBe("gc-lifecycle PASS\n");
	});
});
