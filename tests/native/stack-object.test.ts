import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-stack-object-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("compiled stack objects", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/stack-object.js",
			name: "stack-object",
			outDir,
		});
		({ compiled, interpreted } = pair);
		const caller = pair.programImage.native.functions.find(
			(fn) =>
				fn.body.nameStringIndex >= 0 &&
				String.fromCharCode(
					...pair.programImage.runtime.stringConstants[fn.body.nameStringIndex]!,
				) === "deferredFieldCaller",
		);
		expect(caller?.fieldCalls).toHaveLength(1);
	});

	it("preserves compiled identity, slots, recursion, branches, materialization, and escapes", () => {
		assertPassLine(
			runToStdout(compiled, { env: { MAL_ALLOC_FAIL_TEST: "1" } }),
			"stack-object",
		);
	});

	it("keeps stack slots rooted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(
			runToStdout(compiled, {
				env: { ...STRESS_ENV, MAL_ALLOC_FAIL_TEST: "1" },
				timeoutMs: 60000,
			}),
			"stack-object",
		);
	});

	it("retains interpreted semantic parity", () => {
		assertPassLine(runToStdout(interpreted), "stack-object");
	});

	it("dispatches interpreted allocation failures before a fused continuation", () => {
		assertPassLine(
			runToStdout(interpreted, { env: { MAL_ALLOC_FAIL_TEST: "1" } }),
			"stack-object",
		);
	});
});
