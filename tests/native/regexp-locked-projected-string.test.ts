import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-locked-string-"));
const config = resolveBuildConfig({ engine: { primordials: "locked", regexp: true } });

describe("locked RegExp projected String consumers", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/regexp-locked-projected-string.js",
			name: "regexp-locked-projected-string",
			outDir,
			config,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/regexp-locked-projected-string.js",
			name: "regexp-locked-projected-string-interpreted",
			compiled: false,
			outDir,
			config,
		});
	});

	it("preserves present, missing, and projection-declined semantics", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("preserves the locked specialization under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
