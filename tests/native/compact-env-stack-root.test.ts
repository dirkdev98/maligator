import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

describe("environments held by compiled frames", () => {
	const fixture = "tests/local/compact-env-stack-root.js";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-compact-env-stack-root-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("retain the compact parent scopes a running frame still reads", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const binary = buildNativeBinary({
			fixture,
			name: "compact-env-stack-root",
			compiled: true,
			outDir,
		});
		expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(expected);
	});
});
