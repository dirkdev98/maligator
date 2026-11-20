import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/array-iterator-protocol.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-array-iterator-protocol-"));

describe("generated Array for-of protocol", () => {
	let binary: string;
	let expected: string;

	beforeAll(() => {
		binary = buildNativeBinary({ fixture, name: "array-iterator-protocol", outDir });
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	}, 600_000);
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("observes dynamic length, inherited holes, and iterator overrides", () => {
		expect(runToStdout(binary)).toBe(expected);
	});

	it("keeps iterator state across collection and callbacks under GC stress", () => {
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
	});
});
