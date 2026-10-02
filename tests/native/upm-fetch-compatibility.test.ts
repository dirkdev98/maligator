import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-upm-fetch-"));
let binary: string;

beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/upm-fetch-compatibility.mjs",
		name: "upm-fetch-compatibility",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		webPlatformEnabled: true,
		compiled: true,
	});
}, 180_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("streams and cancels native downloads without retaining timeout signals", () => {
	expect(runToStdout(binary, { timeoutMs: 5000 })).toContain("UPM FETCH PASS");
	expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 5000 })).toContain(
		"UPM FETCH PASS",
	);
});
