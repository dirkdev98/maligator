import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/core-loop-optimizations.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-core-loop-optimizations-"));

describe("Core loop optimization semantics", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "core-loop-optimizations",
			outDir,
		}));
	}, 600_000);

	it("preserves loop behavior in compiled and interpreted modes", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary), ["core-loop-optimizations PASS"]);
		}
	});

	it("preserves loop behavior under GC stress", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
				"core-loop-optimizations PASS",
			]);
		}
	});
});
