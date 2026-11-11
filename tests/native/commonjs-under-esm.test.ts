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

const fixture = "tests/local/commonjs-under-esm/entry.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-commonjs-under-esm-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let expected: string;
beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "commonjs-under-esm",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
it.each(["compiled", "interpreted"] as const)(
	"preserves lazy require evaluation and module identity under an ES entry with %s execution",
	(backend) => {
		const environments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		)
			? [{}]
			: [{}, STRESS_ENV];
		for (const env of environments)
			expect(runToStdout(pair[backend], { env })).toBe(expected);
	},
);
