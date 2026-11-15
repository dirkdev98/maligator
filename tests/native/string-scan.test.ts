import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/string-scan.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-string-scan-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("pure String scans", () => {
	let compiled: string;
	let interpreted: string;
	let expected: Record<string, unknown>;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "string-scan",
			outDir,
		}));
		expected = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as Record<string, unknown>;
	});
	for (const mode of ["compiled", "interpreted"] as const) {
		it.each(["copies", "segments", "counts", "resets", "errors", "iterators"])(
			`preserves %s output in ${mode} mode`,
			(behavior) => {
				const binary = mode === "compiled" ? compiled : interpreted;
				const ordinary = JSON.parse(runToStdout(binary)) as Record<string, unknown>;
				const stressed = JSON.parse(runToStdout(binary, { env: STRESS_ENV })) as Record<
					string,
					unknown
				>;
				expect(ordinary[behavior]).toEqual(expected[behavior]);
				expect(stressed[behavior]).toEqual(expected[behavior]);
			},
		);
	}
});
