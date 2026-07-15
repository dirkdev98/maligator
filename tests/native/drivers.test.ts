import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinaryResult,
	FIBER_MAIN,
	HTTP_MAIN,
	NET_MAIN,
	REACTOR_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BuildNativeBinaryResult } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-drivers-"));

// C driver acceptance tests: each links a bespoke *_test_main.c against a trivial
// isolate and prints a "<tag> PASS N/N" line. All but the pure-function HTTP
// parser also run under collect-at-every-safepoint (they suspend fibers / hold
// live callbacks / sockets across a GC).
const DRIVERS = [
	{ tag: "fibertest", mainFile: FIBER_MAIN, stress: true },
	{ tag: "reactortest", mainFile: REACTOR_MAIN, stress: true },
	{ tag: "nettest", mainFile: NET_MAIN, stress: true },
	{ tag: "httptest", mainFile: HTTP_MAIN, stress: false },
];

describe.each(DRIVERS)("$tag", ({ tag, mainFile, stress }) => {
	let build: BuildNativeBinaryResult;
	beforeAll(() => {
		build = buildNativeBinaryResult({
			fixture: "tests/local/fibertest_stub.js",
			name: tag,
			mainFile,
			outDir,
		});
	});

	it("retains the exact final-link result", () => {
		expect(build.context.features.webPlatformEnabled).toBe(true);
		expect(build.artifacts.linkArgs).toEqual([
			...build.artifacts.c.linkArgs,
			...build.artifacts.rust.linkArgs,
		]);
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(build.binaryPath), tag);
	});

	it.runIf(stress)("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(runToStdout(build.binaryPath, { env: STRESS_ENV }), tag);
	});
});
