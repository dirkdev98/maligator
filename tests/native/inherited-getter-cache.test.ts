import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/inherited-getter-cache.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-inherited-getter-cache-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("inherited getter cache rows", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		compiled = buildNativeBinary({
			fixture,
			name: "inherited-getter-cache",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "inherited-getter-cache-ni",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it("calls the current getter on every read as the chain changes", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps getter rows sound when collections finalize prototypes", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	});
});
