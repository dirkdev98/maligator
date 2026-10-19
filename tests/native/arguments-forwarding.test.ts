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

const fixture = "tests/local/arguments-forwarding.cjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-arguments-forwarding-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function argumentObjects(binary: string): number {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(invocation.executable, invocation.args, {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const line = result.stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-arguments-stats]"));
	expect(line).toBeDefined();
	return Number(line?.match(/(?:^|\s)objects=([0-9]+)/)?.[1]);
}

describe.each(["mutable", "locked"] as const)(
	"arguments forwarding (%s primordials)",
	(primordials) => {
		let compiled: string;
		let interpreted: string;
		let expected: string;
		beforeAll(() => {
			({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
				fixture,
				name: `arguments-forwarding-${primordials}`,
				outDir,
				config: resolveBuildConfig({ engine: { primordials, eval: true } }),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			}));
			expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		}, 600_000);

		it("pass the incoming values, or a real arguments object to any other apply", () => {
			for (const binary of [compiled, interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
			}
		});

		it("forward through builtin apply without building an arguments object", () => {
			// 4000 forwarding calls; the user-defined apply cases build two objects.
			expect(argumentObjects(compiled)).toBeLessThan(20);
		});
	},
);
