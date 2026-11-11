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

const fixture = "tests/local/bigint-arbitrary.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-bigint-arbitrary-"));
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
		name: "bigint-arbitrary",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		evalEnabled: true,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
	});
});
it.each(["compiled", "interpreted"] as const)(
	"preserves full BigInt values across arithmetic, coercion, storage and collection with %s execution",
	(backend) => {
		const environments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		)
			? [{}]
			: [{}, STRESS_ENV];
		for (const env of environments)
			expect(
				runToStdout(pair[backend], {
					env: { ...env, MAL_HOST_GC: "1" },
					timeoutMs: 60000,
				}),
			).toBe(expected);
	},
);

it.each(["compiled", "interpreted"] as const)(
	"retains complete BigInt constants after eval image adoption and collection with %s execution",
	(backend) => {
		const env = { BIGINT_EVAL: "1", MAL_HOST_GC: "1" };
		const expectedEval = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, ...env },
		});
		expect(runToStdout(pair[backend], { env, timeoutMs: 60000 })).toBe(expectedEval);
	},
);
