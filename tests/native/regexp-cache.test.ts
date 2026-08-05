import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-cache-"));

describe("compiled RegExp pattern cache", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/regexp_cache.js",
			name: "regexp-cache",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/regexp_cache.js",
			name: "regexp-cache-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("preserves object identity, state, flags, and invalid-pattern behavior in compiled code", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("preserves object identity, state, flags, and invalid-pattern behavior in interpreted code", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("preserves compiled behavior under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 60_000 }));
	});

	it("preserves interpreted behavior under GC stress", () => {
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV, timeoutMs: 60_000 }));
	});
});
