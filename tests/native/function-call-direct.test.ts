import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-function-call-direct-"));
const expected = ["function-call-direct PASS"];

describe("guarded Function.prototype.call flattening", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/function-call-direct.js",
			name: "function-call-direct",
			// Script parsing covers sloppy receivers without running the eval compiler under GC stress.
			entryGoal: "script",
			entryStrict: false,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			outDir,
		}));
	}, 600_000);
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("preserves direct and generic target semantics", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps shifted receivers and arguments rooted under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	}, 240_000);
});
