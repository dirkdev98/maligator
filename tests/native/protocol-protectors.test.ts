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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-protocol-protectors-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const primordialModes = {
	locked: {},
	mutable: { engine: { primordials: "mutable" } },
} as const;

/** Builds a fixture in one primordial mode and checks both backends against Node. */
function describeProtectors(
	name: string,
	mode: keyof typeof primordialModes,
	title: string,
	admitted?: (stderr: string, loops: number) => void,
): void {
	const fixture = `tests/local/${name}.mjs`;
	describe(`${title} with ${mode} primordials`, () => {
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

		if (admitted === undefined) return;
		it("keeps the iteration fast paths after the polyfill", () => {
			const invocation = resolveHarnessExecutionInvocation(compiled);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe(expected);
			admitted(result.stderr, Number(result.stdout.match(/\bloops=(\d+)/)?.[1]));
		});
	});
}

const counter = (stderr: string, pattern: RegExp) => Number(stderr.match(pattern)?.[1]);

for (const mode of ["locked", "mutable"] as const) {
	describeProtectors(
		"protocol-protectors-polyfill",
		mode,
		"iteration loops after unrelated polyfills",
		(stderr, loops) => {
			// Each round iterates one array and one string without an iterator object;
			// the record loop runs once per round on top.
			expect(counter(stderr, /\bdeferred_array_iterators=(\d+)/)).toBeGreaterThanOrEqual(
				2 * loops,
			);
			expect(counter(stderr, /\bdeferred_string_iterators=(\d+)/)).toBeGreaterThanOrEqual(
				loops,
			);
			expect(
				counter(stderr, /\brecord_iteration_region_admissions=(\d+)/),
			).toBeGreaterThanOrEqual(loops);
			if (mode === "locked") return;
			// The generator and rest-parameter loops each enter guarded once per round.
			expect(
				counter(stderr, /\[perf-semantic-guards\] admissions=(\d+)/),
			).toBeGreaterThanOrEqual(2 * loops);
			expect(
				counter(stderr, /\[perf-semantic-guards\] admissions=\d+ rejections=(\d+)/),
			).toBe(0);
		},
	);
}

// Locked primordials reject every replacement, so only mutable builds can run it.
describeProtectors(
	"protocol-protectors-replaced",
	"mutable",
	"replaced iteration protocol pieces",
);
