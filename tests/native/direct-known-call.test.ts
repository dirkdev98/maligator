import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-direct-known-call-"));
const expected = ["direct-known-call PASS"];

describe("structural direct script-function calls", () => {
	let compiled: string;
	let interpreted: string;
	const frontendCacheEvents: Array<"hit" | "miss"> = [];

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/direct-known-call.js",
			name: "direct-known-call-compiled",
			compiled: true,
			mainFile: "runtime/direct_call_test_main.c",
			outDir,
			onFrontendCacheEvent: ({ cache }) => frontendCacheEvents.push(cache),
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/direct-known-call.js",
			name: "direct-known-call-interpreted",
			compiled: false,
			mainFile: "runtime/direct_call_test_main.c",
			outDir,
			onFrontendCacheEvent: ({ cache }) => frontendCacheEvents.push(cache),
		});
	}, 600_000);

	it("preserves captures, this/callee identity, argument order, and overflow", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("enters interpreted targets directly and falls back on guard failure", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("reuses the shared frontend definition across backend variants", () => {
		expect(frontendCacheEvents).toHaveLength(2);
		expect(frontendCacheEvents[1]).toBe("hit");
	});
});
