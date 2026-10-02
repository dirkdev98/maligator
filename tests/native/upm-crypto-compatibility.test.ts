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

const outDir = mkdtempSync(join(tmpdir(), "mal-upm-crypto-"));
let binary: string;

beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/upm-crypto-compatibility.mjs",
		name: "upm-crypto-compatibility",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		compiled: true,
	});
}, 180_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("matches independent SHA vectors across padding boundaries and buffer windows", () => {
	expect(runToStdout(binary)).toContain("UPM CRYPTO PASS 84");
	expect(runToStdout(binary, { env: STRESS_ENV })).toContain("UPM CRYPTO PASS 84");
});
