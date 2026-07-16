import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-stack-object-"));

describe("compiled stack objects", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/stack-object.js",
			name: "stack-object",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/stack-object.js",
			name: "stack-object-ni",
			compiled: false,
			outDir,
		});
	});

	it("preserves compiled identity, slots, recursion, branches, and escapes", () => {
		assertPassLine(runToStdout(compiled), "stack-object");
	});

	it("keeps stack slots rooted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(
			runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 60000 }),
			"stack-object",
		);
	});

	it("retains interpreted semantic parity", () => {
		assertPassLine(runToStdout(interpreted), "stack-object");
	});
});
