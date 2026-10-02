import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-property-storage-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("preserves encoded property keys, descriptors, borrowed queries, pinned handles and owner GC edges", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "property-storage",
		mainFile: "tests/fixtures/property-storage/main.c",
		outDir,
	});
	expect(
		runToStdout(binary, {
			env: { MAL_GC_VERIFY: "1", MAL_GC_STRESS: "0", MAL_GC_MAJOR_EVERY: "8" },
		}),
	).toBe("property-storage ABI PASS\n");
}, 600_000);
