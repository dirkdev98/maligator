import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-upm-archive-native-"));

describe("bounded archive Node contracts", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/upm-archive-compatibility.mjs",
			name: "compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/upm-archive-compatibility.mjs",
			name: "interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	it("supports bounded gzip, async inputs, cancellation, and file ownership in both backends", () => {
		assertResultPass(runToStdout(compiled, { timeoutMs: 20000 }));
		assertResultPass(runToStdout(interpreted, { timeoutMs: 20000 }));
	});
	it("keeps source, codec, and file state alive under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 20000 }));
	});
});
