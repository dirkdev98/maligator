import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-negative-zero-encodings-"));

function run(binary: string): string {
	const result = spawnSync(binary, [], { encoding: "utf-8", timeout: 60000 });
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "negative-zero-encodings");
	return result.stdout;
}

describe("static Number encodings", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/negative-zero-encodings.js",
			name: "negative-zero-encodings",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/negative-zero-encodings.js",
			name: "negative-zero-encodings-ni",
			compiled: false,
			outDir,
		});
	});

	it("observes a statically encoded -0 identically on both backends", () => {
		expect(run(compiled)).toBe(run(interpreted));
	});
});
