import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

describe("inline DataView access", () => {
	const fixture = "tests/local/data-view-inline.js";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-data-view-inline-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it.each([true, false])(
		"leaves every view, offset, value and buffer state the builtin rejects to it (compiled: %s)",
		(compiled) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const binary = buildNativeBinary({
				fixture,
				name: `data-view-inline-${compiled ? "c" : "i"}`,
				compiled,
				outDir,
			});
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(expected);
		},
		600_000,
	);
});
