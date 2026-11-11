import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/regexp-owned-scratch.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-regexp-owned-scratch-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let expected: string;
beforeAll(() => {
	expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
		encoding: "utf8",
		timeout: 15000,
	});
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "regexp-owned-scratch",
		mainFile: HOST_MAIN,
		outDir,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
	});
});
it.each(["compiled", "interpreted"] as const)(
	"preserves captures across changing encodings and collected subjects with %s execution",
	(backend) => {
		for (const env of ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		)
			? [{}]
			: [{}, STRESS_ENV])
			expect(
				runToStdout(pair[backend], {
					env: { ...env, MAL_HOST_GC: "1" },
					timeoutMs: 60000,
				}),
			).toBe(expected);
	},
);
