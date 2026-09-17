import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/rest-materialization.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-rest-materialization-"));

describe("rest parameter materialization", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let reference: string;
	beforeAll(() => {
		reference = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "rest-materialization",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({ engine: { primordials: "mutable", eval: false } }),
		});
	});
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	for (const backend of ["compiled", "interpreted"] as const) {
		it(`${backend} creates independent own elements despite inherited descriptors`, () => {
			expect(runToStdout(pair[backend])).toBe(reference);
		});
		it(`${backend} retains rest values under GC stress`, () => {
			expect(runToStdout(pair[backend], { env: STRESS_ENV, timeoutMs: 60000 })).toBe(
				reference,
			);
		});
	}
});
