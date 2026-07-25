import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-super-"));

describe("derived constructor eval and arrow super", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/eval-super.js",
			name: "eval-super",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/eval-super.js",
			name: "eval-super-ni",
			compiled: false,
			outDir,
		});
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(compiled), "eval-super");
	});

	it("passes interpreted under GC stress", () => {
		assertPassLine(
			runToStdout(interpreted, {
				env: { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" },
				timeoutMs: 60_000,
			}),
			"eval-super",
		);
	});
});
