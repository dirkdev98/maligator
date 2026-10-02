import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-map-storage-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("specialized Map storage", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/map-storage.js",
			name: "map-storage",
			mainFile: HOST_MAIN,
			outDir,
		}));
	}, 600_000);
	for (const mode of ["compiled", "interpreted"] as const) {
		for (const stress of [false, true]) {
			it(`preserves Map consumers in ${mode}, GC stress=${stress}`, () => {
				assertPassLine(
					runToStdout(mode === "compiled" ? compiled : interpreted, {
						env: { MAL_HOST_GC: "1", MAL_GC_VERIFY: "1", ...(stress ? STRESS_ENV : {}) },
					}),
					"map-storage",
				);
			});
		}
	}
	it("preserves packed keys, present undefined values, ordered pins and minor-owner cards", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "map-storage-abi",
			mainFile: "tests/fixtures/map-storage/main.c",
			outDir,
		});
		expect(
			runToStdout(binary, {
				env: { MAL_GC_VERIFY: "1", MAL_GC_STRESS: "0", MAL_GC_MAJOR_EVERY: "8" },
			}),
		).toBe("map-storage ABI PASS\n");
	});
});
