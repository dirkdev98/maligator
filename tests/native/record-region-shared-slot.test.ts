import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/record-region-shared-slot.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-record-region-shared-slot-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("record iteration over shapes sharing a field slot", () => {
	it("matches Node when rows switch shape, gain a getter or move the field", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "record-region-shared-slot",
			outDir,
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
	}, 600000);
});
