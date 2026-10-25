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

const fixture = "tests/local/numeric-fusion-chains.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-numeric-fusion-chains-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("numeric fusion chains", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves primitive chains and coercive fallbacks with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "numeric-fusion-chains",
				outDir,
				mainFile: HOST_MAIN,
				nativeStackRoots: "precise",
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
			});
			const sum = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "sum",
			);
			expect(
				sum?.specializations.some(
					(region) => region.kind === "numeric-fusion" && region.pairs.length === 3,
				),
			).toBe(true);
			for (const name of [
				"primitiveFusionStart",
				"primitiveFusionFinish",
				"primitiveFusionLink",
				"primitiveFusionStringStart",
				"primitiveFusionStringLink",
				"primitiveFusionStringFinish",
				"primitiveFusionStringCompare",
				"primitiveFusionReverseCompare",
				"resumablePrimitiveFusion",
			]) {
				const native = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				);
				expect(
					native?.specializations.some(
						(region) =>
							region.kind === "numeric-fusion" &&
							region.runtimeGuard === "primitive-number-operands",
					),
					name,
				).toBe(true);
			}
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			for (const binary of [pair.compiled, pair.interpreted])
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		},
		600000,
	);
});
