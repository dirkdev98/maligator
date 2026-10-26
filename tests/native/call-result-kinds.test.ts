import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/call-result-kinds.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-call-result-kinds-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("normal call result kinds and ranges", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves effects, fallbacks and collection with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `call-result-kinds-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				nativeStackRoots: "precise",
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
			});
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of [{}, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
					expect(runToStdout(binary, { env })).toBe(expected);
		},
	);
});
