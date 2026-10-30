import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/bound-call-dispatch.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-bound-call-dispatch-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("cached dispatch after bound function resolution", () => {
	it.each(["locked", "mutable"] as const)(
		"matches Node for receivers, nested arguments, native and proxy targets under %s primordials",
		(primordials) => {
			const expected = execFileSync(
				process.execPath,
				[
					"--input-type=commonjs",
					"-e",
					'require("node:vm").runInThisContext(require("node:fs").readFileSync(process.argv[1], "utf8"))',
					fixture,
				],
				{ encoding: "utf8" },
			);
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `bound-call-dispatch-${primordials}`,
				outDir,
				entryGoal: "script",
				entryStrict: false,
				config: resolveBuildConfig({
					engine: { primordials, realms: primordials === "mutable" },
				}),
			});
			const index = pair.programImage.native.functions.findIndex(
				(plan) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[plan.body.nameStringIndex] ??
							[]),
					) === "invoke",
			);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(
				emitCompiledFunction(pair.programImage.native.functions[index]!, index, "", false)
					?.source,
			).toContain("mal_vm_call_cached");
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			}
		},
		600_000,
	);
});
