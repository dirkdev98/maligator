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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-function-call-direct-"));
const expected = ["function-call-direct PASS"];

describe("guarded Function.prototype.call flattening", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/function-call-direct.js",
			name: "function-call-direct-compiled",
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/function-call-direct.js",
			name: "function-call-direct-interpreted",
			compiled: false,
			outDir,
		});
	}, 600_000);

	it("preserves direct and generic target semantics", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps shifted receivers and arguments rooted under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
