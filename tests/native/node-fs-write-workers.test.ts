import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-fs-write-workers-"));
let binary: string;

beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/node-fs-write-workers.mjs",
		name: "node-fs-write-workers",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
}, 180_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("preserves concurrent write payloads, file descriptors and structured errors", () => {
	assertResultPass(runToStdout(binary));
});

it("retains pending promises and byte sources across GC", () => {
	assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
});
