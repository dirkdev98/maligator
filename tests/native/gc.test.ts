import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { assertPassLine, buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-"));

// Forced-collection host hooks on for every run; the fixture asserts, a failed
// assertion throws (non-zero exit) which runToStdout surfaces.
const HOST_GC: NodeJS.ProcessEnv = { MAL_HOST_GC: "1" };

describe("targeted GC unit tests", () => {
	let compiled: string;
	let interp: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/gctest.js",
			name: "gctest",
			compiled: true,
			outDir,
			skipRuntimeBuild: true,
		});
		interp = buildNativeBinary({
			fixture: "tests/local/gctest.js",
			name: "gctest-ni",
			compiled: false,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	it("compiled backend", () => {
		assertPassLine(runToStdout(compiled, { env: HOST_GC }), "gctest");
	});

	it("compiled + MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(runToStdout(compiled, { env: { ...HOST_GC, ...STRESS_ENV } }), "gctest");
	});

	it("interpreter backend (Tier B root walk)", () => {
		assertPassLine(runToStdout(interp, { env: HOST_GC }), "gctest");
	});
});
