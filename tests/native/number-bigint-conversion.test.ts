import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/number-bigint-conversion.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-number-bigint-conversion-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
it.each(["locked", "mutable"] as const)(
	"preserves BigInt conversion and observable fallback under %s primordials",
	(primordials) => {
		const environment = { ...process.env, NUMBER_CONVERSION_PRIMORDIALS: primordials };
		const expected = execFileSync(process.execPath, [fixture, "values"], {
			env: environment,
			encoding: "utf8",
			timeout: 10000,
		});
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `number-bigint-${primordials}`,
			outDir,
			config: resolveBuildConfig({
				engine: { primordials, eval: false, realms: false },
				surface: { node: true },
			}),
		});
		for (const target of [pair.compiled, pair.interpreted]) {
			const invocation = resolveHarnessExecutionInvocation(target);
			const result = spawnSync(invocation.executable, [...invocation.args, "values"], {
				env: { ...environment, ...STRESS_ENV },
				encoding: "utf8",
				timeout: 30000,
			});
			expect(result.status, result.error?.message ?? result.stderr).toBe(0);
			expect(result.stdout).toBe(expected);
		}
	},
);
