import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(tmpdir(), "mal-ffi-discard-delivery-"));
let binary: string;
beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "ffi-discard-delivery",
		mainFile: "runtime/ffi_discard_test_main.c",
		outDir: directory,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
		regexpEnabled: false,
		webPlatformEnabled: true,
	});
}, 240_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it("rejects lost deliveries and preserves an existing resource during cleanup", () => {
	expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
		"ffi discarded delivery passed\n",
	);
});
it("destroys a fresh recycled alias once after a nonfresh alias", () => {
	expect(
		runToStdout(binary, { env: { ...STRESS_ENV, MAL_FFI_DISCARD_FRESH: "1" } }),
	).toBe("ffi fresh discard passed\n");
});
it("destroys a fresh recycled alias from native claims after VM teardown", () => {
	expect(
		runToStdout(binary, { env: { ...STRESS_ENV, MAL_FFI_DISCARD_NATIVE_FRESH: "1" } }),
	).toBe("ffi fresh discard passed\n");
});
