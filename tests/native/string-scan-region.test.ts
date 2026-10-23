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

const fixture = "tests/local/string-scan-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-scan-region-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function textRegions(
	pair: ReturnType<typeof buildBackendPairFromOneProgramImage>,
	name: string,
) {
	const fn = pair.programImage.native.functions.find(
		(candidate) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[candidate.body.nameStringIndex] ??
					[]),
			) === name,
	);
	return (fn?.storage?.numericLoopRegions ?? []).filter(
		(plan) =>
			plan.kind === "fixed-numeric" && plan.views.some((view) => view.text === true),
	);
}

describe("string scan loop regions", () => {
	it.each(["mutable", "locked"] as const)(
		"read code units of primitive strings directly and decline every other receiver with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `string-scan-region-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
			});
			// Only locked primordials make `charCodeAt` on a primitive string the builtin.
			for (const name of [
				"skipValue",
				"skipSpaces",
				"hashUnits",
				"evenUnits",
				"lastDigitRun",
				"countWords",
			])
				expect(textRegions(pair, name).length > 0, name).toBe(primordials === "locked");
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of [{}, STRESS_ENV])
					expect(runToStdout(binary, { env, timeoutMs: 60_000 })).toBe(expected);
		},
		600_000,
	);
});
