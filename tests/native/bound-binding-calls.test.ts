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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-bound-binding-calls-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function runNode(fixture: string, script: boolean): string {
	return script
		? execFileSync(
				process.execPath,
				[
					"--input-type=commonjs",
					"-e",
					'require("node:vm").runInThisContext(require("node:fs").readFileSync(process.argv[1], "utf8"))',
					fixture,
				],
				{ encoding: "utf8" },
			)
		: execFileSync(process.execPath, [fixture], { encoding: "utf8" });
}

/** Calls the runtime dispatched through a bound function rather than to its target. */
function genericBoundCalls(binary: string, expected: string): number {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(invocation.executable, invocation.args, {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	expect(result.stdout).toBe(expected);
	const counters = result.stderr.match(
		/\[perf-bound-calls\] resolutions=(\d+) calls=(\d+)/,
	);
	expect(counters, result.stderr).not.toBeNull();
	return Number(counters![1]) + Number(counters![2]);
}

/** Numeric loop regions whose entry loaded an invariant field or checked a callee. */
function invariantRegionAdmissions(binary: string, expected: string): number {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(invocation.executable, invocation.args, {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	expect(result.stdout).toBe(expected);
	const admissions = result.stderr.match(
		/\[perf-loop-invariant-stats\] admissions=(\d+)/,
	);
	expect(admissions, result.stderr).not.toBeNull();
	return Number(admissions![1]);
}

/** Builds a fixture for both backends and checks each against Node, also under GC stress. */
function describeBoundBindings(
	fixture: string,
	primordials: "locked" | "mutable",
	title: string,
	options: {
		readonly script?: true;
		readonly warmCalls?: (stdout: string) => number;
		readonly warmRegions?: (stdout: string) => number;
	} = {},
): void {
	describe(`${title} under ${primordials} primordials`, () => {
		let compiled: string;
		let interpreted: string;
		let expected: string;
		beforeAll(() => {
			({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
				fixture,
				name: `${path.basename(fixture).replace(/\.m?js$/, "")}-${primordials}`,
				outDir,
				config: resolveBuildConfig({ engine: { primordials } }),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
				...(options.script ? { entryGoal: "script" as const, entryStrict: false } : {}),
			}));
			expected = runNode(fixture, options.script === true);
		}, 600_000);

		for (const mode of ["compiled", "interpreted"] as const) {
			it(`matches Node in ${mode} mode`, () => {
				const binary = mode === "compiled" ? compiled : interpreted;
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			});
		}

		const warmCalls = options.warmCalls;
		if (warmCalls !== undefined)
			it("calls the bound target directly in the warm loops", () => {
				expect(genericBoundCalls(compiled, expected)).toBeLessThan(warmCalls(expected));
			});

		const warmRegions = options.warmRegions;
		if (warmRegions !== undefined)
			it("runs the warm loops as numeric regions around the inlined target", () => {
				expect(invariantRegionAdmissions(compiled, expected)).toBeGreaterThanOrEqual(
					warmRegions(expected),
				);
			});
	});
}

// Each warm-up round calls the module binding once per iteration.
const warmLoopCalls = (stdout: string): number =>
	Number(stdout.match(/\bloops=(\d+)/)?.[1]) *
	Number(stdout.match(/\brounds=(\d+)/)?.[1]);

for (const primordials of ["locked", "mutable"] as const) {
	describeBoundBindings(
		"tests/local/bound-binding-calls.mjs",
		primordials,
		"calls of module and captured bindings holding bound functions",
		{ warmCalls: warmLoopCalls },
	);
	describeBoundBindings(
		"tests/local/bound-binding-loop-regions.mjs",
		primordials,
		"numeric loops calling bindings that hold bound functions",
		{
			warmCalls: warmLoopCalls,
			// Each warm-up round runs three loops calling a bound function.
			warmRegions: (stdout) => 3 * Number(stdout.match(/\bloops=(\d+)/)?.[1]),
		},
	);
}

describeBoundBindings(
	"tests/local/bound-binding-sloppy.js",
	"locked",
	"bound sloppy targets held in captured bindings",
	{ script: true },
);

describeBoundBindings(
	"tests/local/mutable-bound-binding.mjs",
	"mutable",
	"bound function bindings while Function.prototype.bind is replaced",
	{
		warmCalls: warmLoopCalls,
		warmRegions: (stdout) => Number(stdout.match(/\bloops=(\d+)/)?.[1]),
	},
);
