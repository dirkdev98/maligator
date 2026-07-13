import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shadow-realm-"));
const GC_BOUNDARY_ENV: NodeJS.ProcessEnv = {
	MAL_HOST_GC: "1",
	MAL_GC_STRESS: "10000",
	MAL_GC_VERIFY: "1",
};

describe("ShadowRealm", () => {
	let compiled: string;
	let interpreted: string;
	let evalDisabled: string;
	let disabled: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/shadow-realm.js",
			name: "shadow-realm",
			compiled: true,
			outDir,
			realmsEnabled: true,
			skipRuntimeBuild: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/shadow-realm.js",
			name: "shadow-realm-ni",
			compiled: false,
			outDir,
			realmsEnabled: true,
			skipRuntimeBuild: true,
		});
		evalDisabled = buildNativeBinary({
			fixture: "tests/local/shadow-realm-eval-disabled.js",
			name: "shadow-realm-eval-disabled",
			outDir,
			realmsEnabled: true,
			evalEnabled: false,
		});
		disabled = buildNativeBinary({
			fixture: "tests/local/shadow-realm-disabled.js",
			name: "shadow-realm-disabled",
			outDir,
			realmsEnabled: false,
		});
	});

	it("passes compiled", () => {
		assertExactLines(runToStdout(compiled), ["shadow-realm PASS"]);
	});

	it("passes interpreted", () => {
		assertExactLines(runToStdout(interpreted), ["shadow-realm PASS"]);
	});

	it("survives GC stress/verify at realm boundaries", () => {
		assertExactLines(runToStdout(compiled, { env: GC_BOUNDARY_ENV, timeoutMs: 60000 }), [
			"shadow-realm PASS",
		]);
	});

	it("preserves the caller-realm EvalError when eval is disabled", () => {
		assertExactLines(runToStdout(evalDisabled), ["shadow-realm-eval-disabled PASS"]);
	});

	it("omits ShadowRealm when realms are disabled", () => {
		assertExactLines(runToStdout(disabled), ["shadow-realm-disabled PASS"]);
	});
});
