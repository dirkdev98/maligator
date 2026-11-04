import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";
const outDir = mkdtempSync(join(tmpdir(), "mal-unicode-kernels-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("native Unicode transformations", () => {
	let binary: string;
	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "unicode-ascii-transforms",
			mainFile: "tests/fixtures/unicode-ascii-transforms/main.c",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			config: resolveBuildConfig({
				engine: { eval: false, realms: false, regexp: false, intl: { enabled: false } },
				surface: { node: false, webPlatform: false, maligator: false },
			}),
		});
	});
	it("preserves locale context, expansion, composition and lone surrogates", () => {
		expect(runToStdout(binary, { env: { UNICODE_CASE_STORAGE: "0" } })).toBe(
			"unicode-ascii-transforms PASS\n",
		);
	});
	it("keeps case storage rooted and reports RAW allocation failure", () => {
		expect(runToStdout(binary, { env: { UNICODE_CASE_STORAGE: "1" } })).toBe(
			"unicode-case-storage PASS\n",
		);
	});
});
