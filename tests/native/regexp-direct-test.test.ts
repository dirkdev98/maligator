import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-direct-test-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const primordialModes = {
	locked: {},
	mutable: { engine: { primordials: "mutable" } },
} as const;

const counter = (stderr: string, name: string) =>
	Number(stderr.match(new RegExp(`\\b${name}=(\\d+)`))?.[1]);

function describeFixture(name: string, mode: keyof typeof primordialModes): void {
	const fixture = `tests/local/${name}.mjs`;
	describe(`${name} with ${mode} primordials`, () => {
		let compiled: string;
		let interpreted: string;
		let expected: string;
		beforeAll(() => {
			({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
				fixture,
				name: `${name}-${mode}`,
				outDir,
				config: resolveBuildConfig(primordialModes[mode]),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			}));
			expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		});

		for (const backend of ["compiled", "interpreted"] as const) {
			it(`matches Node in ${backend} mode`, () => {
				const binary = backend === "compiled" ? compiled : interpreted;
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			});
		}

		it("runs literal sites and reused RegExps against their matchers", () => {
			const invocation = resolveHarnessExecutionInvocation(compiled);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe(expected);
			expect(counter(result.stderr, "literal_bindings")).toBeGreaterThan(0);
			expect(counter(result.stderr, "literal_direct_calls")).toBeGreaterThan(0);
			expect(counter(result.stderr, "direct_test_calls")).toBeGreaterThan(0);
		});
	});
}

describeFixture("regexp-direct-test", "locked");
describeFixture("regexp-direct-test", "mutable");
describeFixture("regexp-direct-test-mutable", "mutable");
