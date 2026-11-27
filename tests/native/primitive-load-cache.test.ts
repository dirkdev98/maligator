import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/primitive-load-cache.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-primitive-cache-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let expected: string;
beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "primitive-load-cache",
		outDir,
	});
});

it.each(["compiled", "interpreted"] as const)(
	"caches primitive methods and exotic lengths in %s mode",
	(backend) => {
		expect(runToStdout(pair[backend])).toBe(expected);
	},
);

it.each(["compiled", "interpreted"] as const)(
	"preserves mixed receivers and cache invalidation through GC in %s mode",
	(backend) => {
		expect(
			runToStdout(pair[backend], {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	},
);
