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

const fixture = "tests/local/iterator-result-properties.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-iterator-result-properties-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["conservative", "precise"] as const)("%s roots", (nativeStackRoots) => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			outDir,
			name: `iterator-results-${nativeStackRoots}`,
			nativeStackRoots,
			config: resolveBuildConfig({
				surface: { node: true },
				engine: { primordials: "mutable", eval: false, realms: false },
			}),
		});
	});

	it.each([
		{
			scenario: "shapes",
			behavior: "reads current values across changing iterator-result layouts",
		},
		{
			scenario: "getters",
			behavior: "reads value after done getters and skips it when iteration completes",
		},
		{ scenario: "proxies", behavior: "preserves iterator-result Proxy access order" },
		{
			scenario: "protocols",
			behavior: "preserves specialized iterators and their overridden next methods",
		},
		{
			scenario: "calls",
			behavior: "preserves iterator next receivers, arguments and callable fallbacks",
		},
		{ scenario: "abrupt", behavior: "propagates iterator-result getter exceptions" },
	] as const)("$behavior", ({ scenario }) => {
		const env = { ITERATOR_RESULT_CASE: scenario };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { env })).toBe(expected);
			expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
		}
	});
});
