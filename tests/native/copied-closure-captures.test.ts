import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/copied-closure-captures.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-copied-closure-captures-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["conservative", "precise"] as const)(
	"%s capture roots",
	(nativeStackRoots) => {
		let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
		beforeAll(() => {
			pair = buildBackendPairFromOneProgramImage({
				fixture,
				outDir,
				name: `copied-closure-captures-${nativeStackRoots}`,
				nativeStackRoots,
				config: resolveBuildConfig({ surface: { node: true } }),
			});
			const factory = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "immutableFactory",
			);
			expect(factory?.storage?.captures.copiedClosureIps.length).toBeGreaterThan(0);
		});

		it.each([
			{
				scenario: "retained",
				behavior: "retains distinct scalar and heap captures after their owners return",
			},
			{
				scenario: "mutable",
				behavior: "shares writes between closures that retain a mutable binding",
			},
			{
				scenario: "mixed",
				behavior: "preserves copied readers when another path materializes their owner",
			},
			{
				scenario: "uninitialized",
				behavior: "preserves temporal dead zones before captured initialization",
			},
		] as const)("$behavior", ({ scenario }) => {
			const env = { COPIED_CAPTURE_CASE: scenario };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary, { env })).toBe(expected);
				expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
			}
		});
	},
);
