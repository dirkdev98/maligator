import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertResultPass, buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";

describe("computed dynamic import", () => {
	it("loads a bundled module by its runtime absolute path", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-dynamic-import-"));
		const binary = buildNativeBinary({
			fixture: "tests/local/dynamic-import-computed.mjs",
			name: "dynamic-import-computed",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		const result = spawnSync(binary, [], { encoding: "utf8", timeout: 20_000 });
		expect(result.status, result.stderr).toBe(0);
		assertResultPass(result.stdout);
	}, 300_000);
});
