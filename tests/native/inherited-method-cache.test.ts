import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-inherited-method-cache-"));

describe("inherited built-in method and native call caches", () => {
	let compiled: string;
	let interpreted: string;
	let monkeyPatch: string;
	let accessor: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache.js",
			name: "inherited-method-cache",
			compiled: true,
			outDir,
			skipRuntimeBuild: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache.js",
			name: "inherited-method-cache-ni",
			compiled: false,
			outDir,
			skipRuntimeBuild: true,
		});
		monkeyPatch = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache-monkey-patch.js",
			name: "inherited-method-cache-monkey-patch",
			compiled: true,
			outDir,
			skipRuntimeBuild: true,
		});
		accessor = buildNativeBinary({
			fixture: "tests/local/inherited-method-cache-accessor.js",
			name: "inherited-method-cache-accessor",
			compiled: true,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	it("handles repeated loads/calls, shadows, prototypes, realms, and completions", () => {
		assertExactLines(runToStdout(compiled, { env: { MAL_HOST_GC: "1" } }), [
			"inherited-method-cache PASS",
		]);
	});

	it("uses the same miss/fill path in the interpreter", () => {
		assertExactLines(runToStdout(interpreted, { env: { MAL_HOST_GC: "1" } }), [
			"inherited-method-cache PASS",
		]);
	});

	it("preserves native callback roots under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
			["inherited-method-cache PASS"],
		);
	});

	it("invalidates on Date.prototype assignment", () => {
		assertExactLines(runToStdout(monkeyPatch), [
			"inherited-method-cache-monkey-patch PASS",
		]);
	});

	it("invalidates on Date.prototype accessor replacement", () => {
		assertExactLines(runToStdout(accessor), ["inherited-method-cache-accessor PASS"]);
	});
});
