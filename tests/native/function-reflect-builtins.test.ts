import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-function-reflect-builtins-"));
const expected = ["function-reflect-builtins PASS"];
const stressEnv = { ...process.env, ...STRESS_ENV };

describe("Function and Reflect builtins", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/function-reflect-builtins.js",
			name: "function-reflect-builtins",
			entryGoal: "script",
			outDir,
		}));
	}, 600_000);

	it(
		"preserves native Function and Reflect semantics",
		() => {
			assertExactLines(runToStdout(compiled), expected);
			assertExactLines(runToStdout(interpreted), expected);
		},
		Math.max(60_000, 2 * scaledNativeRunTimeoutMs() + 10_000),
	);

	it(
		"keeps materialized and bound argument lists rooted under GC stress",
		() => {
			assertExactLines(runToStdout(compiled, { env: stressEnv }), expected);
			assertExactLines(runToStdout(interpreted, { env: stressEnv }), expected);
		},
		Math.max(60_000, 2 * scaledNativeRunTimeoutMs(undefined, stressEnv) + 10_000),
	);
});
