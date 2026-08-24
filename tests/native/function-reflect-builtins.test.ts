import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneDefinition,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-function-reflect-builtins-"));
const expected = ["function-reflect-builtins PASS"];

describe("Function and Reflect builtins", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneDefinition({
			fixture: "tests/local/function-reflect-builtins.js",
			name: "function-reflect-builtins",
			outDir,
		}));
	}, 600_000);

	it("preserves native Function and Reflect semantics", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps materialized and bound argument lists rooted under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
