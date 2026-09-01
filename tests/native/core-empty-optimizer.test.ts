import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-core-empty-optimizer-"));

describe("sealed Core with the empty optimizer", () => {
	let binaries: BackendPairResult;

	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/core-empty-optimizer.mjs",
			name: "core-empty-optimizer",
			outDir,
		});
	}, 600_000);

	it.each(["compiled", "interpreted"] as const)(
		"preserves exceptions, generators, and async execution in %s mode",
		(mode) => {
			expect(runToStdout(binaries[mode]).trim()).toBe(
				"core-empty-optimizer:7:caught:true",
			);
		},
	);
});
