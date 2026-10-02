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

const outDir = mkdtempSync(join(tmpdir(), "mal-upm-filesystem-native-"));

describe("filesystem and workspace Node contracts", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/upm-filesystem-compatibility.mts",
			name: "compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/upm-filesystem-compatibility.mts",
			name: "interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	it("supports promise mutations, missing stats, glob traversal, and path matching in both backends", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});
	it("keeps iterator and filesystem state alive under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});
});
