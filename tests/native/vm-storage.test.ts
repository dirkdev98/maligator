import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

describe("VM storage", () => {
	it("starts and tears down a host program in storage that holds stale bytes", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/vm-storage.js",
			name: "vm-storage",
			mainFile: "runtime/vm_storage_test_main.c",
		});
		for (const env of [{}, STRESS_ENV]) {
			expect(runToStdout(binary, { env })).toBe("vm-storage 2000 record 1999 3998000\n");
		}
	});
});
