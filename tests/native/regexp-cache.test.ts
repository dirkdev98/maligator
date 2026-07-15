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
	let bin: string;

	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/regexp_cache.js",
			name: "regexp-cache",
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("preserves object identity, state, flags, and invalid-pattern behavior", () => {
		assertResultPass(runToStdout(bin));
	});

	it("preserves behavior under GC stress", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
