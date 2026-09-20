import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/inline-collection-storage.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-inline-collection-storage-"));

describe("inline collection storage hints", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "inline-collection-storage",
			outDir,
		}));
	}, 600_000);

	it("preserves growth, deletion, clear, and tracing semantics", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary, { env: { MAL_HOST_GC: "1" } }), [
				"inline-collection-storage PASS",
			]);
		}
	});

	it("survives GC stress and verification", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(
				runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } }),
				["inline-collection-storage PASS"],
			);
		}
	});
});
