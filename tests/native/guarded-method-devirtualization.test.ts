import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/guarded-method-devirtualization.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-guarded-method-"));

describe("guarded method devirtualization", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		compiled = buildNativeBinary({
			fixture,
			name: "guarded-method",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "guarded-method-interpreted",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it("preserves polymorphism and all loaded-callee fallbacks", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps inlined receiver values rooted under GC stress", () => {
		expect(
			runToStdout(compiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});
});
