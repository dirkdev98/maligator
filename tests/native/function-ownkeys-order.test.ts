import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/function-ownkeys-order.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-function-ownkeys-order-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("enumerates function own keys in creation order like Node", () => {
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "function-ownkeys-order",
		outDir,
	});
	for (const backend of ["compiled", "interpreted"] as const) {
		expect(runToStdout(pair[backend]), backend).toBe(expected);
	}
});
