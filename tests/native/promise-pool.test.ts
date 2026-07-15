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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-promise-pool-"));
const expected = ["promise-pool PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("pooled promise reactions and jobs", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/promise-pool.js",
			name: "promise-pool",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/promise-pool.js",
			name: "promise-pool-ni",
			compiled: false,
			outDir,
		});
	});

	it("preserves pairing, FIFO ordering, and mixed job kinds in compiled code", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
	});

	it("preserves compiled jobs under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});

	it("preserves pairing, FIFO ordering, and mixed job kinds in interpreted code", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves interpreted jobs under GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});
});
