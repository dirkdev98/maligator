import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-executor-"));
let binary: string;

beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "executor",
		mainFile: "runtime/executor_test_main.c",
		outDir,
	});
});

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("shares bounded helper capacity and tears down an owner without waiting for another", () => {
	expect(runToStdout(binary)).toBe("executor PASS\n");
});
