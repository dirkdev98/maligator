import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-dependent-string-p1-item8-"));
const expected = ["dependent-string-p1-item8 PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("GC-traced dependent strings", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/dependent-string-p1-item8.js",
			name: "dependent-string-p1-item8",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/dependent-string-p1-item8.js",
			name: "dependent-string-p1-item8-ni",
			compiled: false,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	it("retains indexed, iterated, extracted, and spread slices in compiled code", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
	});

	it("retains slices in compiled code under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});

	it("retains indexed, iterated, extracted, and spread slices in interpreted code", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("retains slices in interpreted code under GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});
});
