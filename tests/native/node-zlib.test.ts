import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-zlib-"));

const nativeFeatures = {
	evalEnabled: false,
	realmsEnabled: false,
	intlEnabled: false,
	temporalEnabled: false,
};

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("node:zlib decompression adapter", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			...nativeFeatures,
			fixture: "tests/local/node-zlib.mjs",
			name: "node-zlib-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			...nativeFeatures,
			fixture: "tests/local/node-zlib.mjs",
			name: "node-zlib-interpreted",
			mainFile: HOST_MAIN,
			outDir,
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

it("decodes gzip through a statically used CommonJS export", () => {
	const binary = buildNativeBinary({
		...nativeFeatures,
		fixture: "tests/local/node-zlib-static-decoder.cjs",
		name: "node-zlib-static-decoder",
		mainFile: HOST_MAIN,
		outDir,
	});
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe("alpha\n");
});
