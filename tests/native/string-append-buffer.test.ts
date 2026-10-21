import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

describe("strings built by repeated appends", () => {
	const fixture = "tests/local/string-append-buffer.js";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-append-buffer-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("keep every result's contents across branches, slices, widening and collection", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const binary = buildNativeBinary({
			fixture,
			name: "string-append-buffer",
			compiled: true,
			outDir,
		});
		expect(runToStdout(binary)).toBe(expected);
		expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(expected);
	});
});
