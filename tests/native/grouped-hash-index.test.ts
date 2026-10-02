import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-grouped-hash-index-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("preserves collided membership, pinned handles and clear continuations in every table role", () => {
	const binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "grouped-hash-index",
		mainFile: "tests/fixtures/grouped-hash-index/main.c",
		outDir,
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	});
	assertPassLine(
		runToStdout(binary, { env: { MAL_GC_VERIFY: "1", MAL_GC_STRESS: "0" } }),
		"grouped-hash-index",
	);
}, 600_000);
