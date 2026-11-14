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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-iteration-exits-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function denseArrayRegionCounter(stderr: string, name: string): number {
	const match = new RegExp(`\\[perf-dense-array-region-stats\\].* ${name}=(\\d+)`).exec(
		stderr,
	);
	if (match === null) throw new Error(`missing ${name} in ${stderr}`);
	return Number(match[1]);
}

/**
 * Builds a fixture and checks both backends against Node. Each warm loop of the
 * fixture reaches every listed region counter at least once.
 */
function describeExits(
	fixture: string,
	title: string,
	primordials: "locked" | "mutable",
	// The fixture's warm loop count, printed as `<name>=<count>`.
	loops: RegExp,
	counters: Readonly<Record<string, string>>,
): void {
	describe(title, () => {
		let compiled: string;
		let interpreted: string;
		let expected: string;
		beforeAll(() => {
			({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
				fixture,
				name: path.basename(fixture).replace(/\.[cm]?js$/, ""),
				outDir,
				config: resolveBuildConfig(
					primordials === "mutable" ? { engine: { primordials: "mutable" } } : {},
				),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			}));
			expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		}, 600_000);

		for (const [behavior, name] of Object.entries(counters))
			it(behavior, () => {
				const invocation = resolveHarnessExecutionInvocation(compiled);
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, MAL_PERF_STATS: "1" },
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toBe(expected);
				expect(denseArrayRegionCounter(result.stderr, name)).toBeGreaterThanOrEqual(
					Number(loops.exec(result.stdout)?.[1]),
				);
			});

		it("matches Node under compiled GC stress", () => {
			expect(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(
				expected,
			);
		});

		it("matches Node when interpreted", () => {
			expect(runToStdout(interpreted, { timeoutMs: 60_000 })).toBe(expected);
		});
	});
}

const closesInRegions = "leaves warm loops through break and return inside regions";

describeExits(
	"tests/local/array-iteration-exits.cjs",
	"for-of exits over Arrays",
	"locked",
	/\brounds=(\d+)/,
	{
		[closesInRegions]: "close-exits",
		"returns to integer arithmetic after a leading fraction": "integer-returns",
	},
);
// Locked primordials reject replacing the iterator's `return`.
describeExits(
	"tests/local/array-iteration-exits-protocol.mjs",
	"for-of exits while the Array iterator's return changes",
	"mutable",
	/\bloops=(\d+)/,
	{ [closesInRegions]: "close-exits" },
);
