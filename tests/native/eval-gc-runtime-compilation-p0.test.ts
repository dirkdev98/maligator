import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-gc-runtime-compilation-p0-"));
const TEST_ENV: NodeJS.ProcessEnv = { MAL_TEST262: "1" };
// Runtime compilation executes enough safepoints to collect repeatedly at this
// interval without turning every interpreted compiler instruction into a full GC.
const COMPILER_STRESS_ENV: NodeJS.ProcessEnv = {
	MAL_GC_STRESS: "1000",
	MAL_GC_VERIFY: "1",
};

describe("runtime compilation GC roots", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/eval-gc-runtime-compilation-p0.js",
			name: "eval-gc-runtime-compilation-p0",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/eval-gc-runtime-compilation-p0.js",
			name: "eval-gc-runtime-compilation-p0-ni",
			compiled: false,
			outDir,
		});
	});

	it("passes compiled under GC stress and verification", () => {
		assertPassLine(
			runToStdout(compiled, {
				env: { ...TEST_ENV, ...COMPILER_STRESS_ENV },
				timeoutMs: 60000,
			}),
			"eval-gc-runtime-compilation-p0",
		);
	});

	it("passes interpreted under GC stress and verification", () => {
		assertPassLine(
			runToStdout(interpreted, {
				env: { ...TEST_ENV, ...COMPILER_STRESS_ENV },
				timeoutMs: 60000,
			}),
			"eval-gc-runtime-compilation-p0",
		);
	});
});
