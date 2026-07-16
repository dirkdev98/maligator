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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-coroutine-pool-"));
const expected = ["coroutine-pool PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("pooled suspendable-frame support", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/coroutine-pool.js",
			name: "coroutine-pool",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/coroutine-pool.js",
			name: "coroutine-pool-ni",
			compiled: false,
			outDir,
		});
	});

	it("reuses compiled frames and preserves queued async-generator requests", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
	});

	it("preserves compiled support nodes under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});

	it("reuses interpreted register/argument buffers and preserves request order", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves interpreted support nodes under GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});
});
