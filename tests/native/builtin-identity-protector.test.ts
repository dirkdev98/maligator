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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-builtin-identity-protector-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const primordialModes = {
	locked: {},
	mutable: { engine: { primordials: "mutable" } },
} as const;

/** Builds a fixture in one primordial mode and checks both backends against Node. */
function describeIdentities(
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
		it("keeps the builtin fast paths after the polyfill", () => {
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

const counter = (stderr: string, name: string) =>
	Number(stderr.match(new RegExp(`\\b${name}=(\\d+)`))?.[1]);

for (const mode of ["locked", "mutable"] as const) {
	describeIdentities(
		"builtin-identity-polyfill",
		mode,
		"builtin identities after unrelated polyfills",
		(stderr, loops) => {
			// Each round destructures the five Map entries and the five Set entries.
			expect(counter(stderr, "entry_pair_hits")).toBeGreaterThanOrEqual(10 * loops);
			// Each settle round aggregates two intrinsic promises.
			expect(counter(stderr, "all_typed_admissions")).toBeGreaterThanOrEqual(loops);
			// Locked builds call charCodeAt as a known operation and store literal
			// Object.assign sources field by field instead.
			if (mode === "locked") return;
			// Each round merges one literal source despite the Object.prototype polyfill.
			expect(counter(stderr, "merge_shaped_hits")).toBeGreaterThanOrEqual(loops);
			// Each round reads every character of a 168-character string.
			expect(counter(stderr, "char_code_at_direct_hits")).toBeGreaterThanOrEqual(
				168 * loops,
			);
		},
	);
}

// Locked primordials reject every replacement, so only mutable builds can run it.
describeIdentities(
	"builtin-identity-replaced",
	"mutable",
	"replaced, deleted and shadowed builtin methods",
);
