import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(
	path.join(os.tmpdir(), "mal-interpreter-call-cache-p1-item9-"),
);
const expected = ["interpreter-call-cache-p1-item9 PASS"];
const compilerStressEnv = { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" };

describe("bounded interpreter call-site cache", () => {
	let interpreted: string;
	let mixed: string;

	beforeAll(() => {
		interpreted = buildNativeBinary({
			fixture: "tests/local/interpreter-call-cache-p1-item9.js",
			name: "interpreter-call-cache-p1-item9-ni",
			compiled: false,
			outDir,
		});
		mixed = buildNativeBinary({
			fixture: "tests/local/interpreter-call-cache-p1-item9.js",
			name: "interpreter-call-cache-p1-item9-mixed",
			compiled: true,
			outDir,
		});
	});

	it("preserves direct interpreted calls, eval splices, and fallback semantics", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { MAL_HOST_GC: "1" }, timeoutMs: 60_000 }),
			expected,
		);
	});

	it("falls back from interpreted eval code to compiled callees", () => {
		assertExactLines(
			runToStdout(mixed, { env: { MAL_HOST_GC: "1" }, timeoutMs: 60_000 }),
			expected,
		);
	});

	it("keeps epoch-guarded identities safe under GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, {
				env: { MAL_HOST_GC: "1", ...compilerStressEnv },
				timeoutMs: 60_000,
			}),
			expected,
		);
	});
});
