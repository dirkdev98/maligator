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
	it("keeps a chain of generic arithmetic unboxed and falls back with every operand kind", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "numeric-fusion-chains",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({ engine: { eval: false, realms: false } }),
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
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
	}, 600000);
});
