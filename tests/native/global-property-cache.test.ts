import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-global-property-cache-"));

describe("script global property cache", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/global-property-cache.js",
			name: "global-property-cache",
			entryGoal: "script",
			outDir,
			realmsEnabled: true,
		}));
	});

	it("preserves global property semantics in compiled code", () => {
		assertExactLines(runToStdout(compiled), ["global-property-cache PASS"]);
	});

	it("preserves global property semantics in interpreted code", () => {
		assertExactLines(runToStdout(interpreted), ["global-property-cache PASS"]);
	});

	it("preserves cached object values under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, {
				env: { MAL_GC_STRESS: "10000", MAL_GC_VERIFY: "1" },
				timeoutMs: 60_000,
			}),
			["global-property-cache PASS"],
		);
	});
});
