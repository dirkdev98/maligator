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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-zlib-"));

describe("node:zlib decompression adapter", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-zlib.mjs",
			name: "node-zlib-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/node-zlib.mjs",
			name: "node-zlib-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("decompresses real vectors in compiled mode", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("decompresses real vectors in interpreted mode", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
