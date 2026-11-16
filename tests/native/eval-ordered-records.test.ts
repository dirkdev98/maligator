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

const fixture = "tests/local/eval-ordered-records.cjs";
const expected = JSON.parse(
	execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
) as Record<string, unknown>;
// Use ECMA-262 14.3.2.1 reference ordering independently of the reference engine.
expected.capturedInitializerReference = [5, null];
// HasBinding and GetBindingValue each probe HasProperty, including the second visible Proxy trap.
expected.proxyLookup = [
	2,
	[
		["has", "eval"],
		["has", "value"],
		["get", "Symbol(Symbol.unscopables)"],
		["has", "value"],
		["get", "value"],
	],
];

describe.each(["conservative", "precise"] as const)(
	"ordered eval records with %s roots",
	(nativeStackRoots) => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-eval-ordered-"));
		afterAll(() => rmSync(outDir, { recursive: true, force: true }));
		const outputs: Array<Record<string, unknown>> = [];
		beforeAll(() => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "eval-ordered",
				outDir,
				nativeStackRoots,
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: true },
					surface: { node: true },
				}),
			});
			const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
				(key) => process.env[key] === "1",
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
					outputs.push(
						JSON.parse(runToStdout(binary, { env })) as Record<string, unknown>,
					);
		});
		it.each(Object.keys(expected))("preserves %s through ordered eval records", (key) => {
			for (const output of outputs) expect(output[key]).toEqual(expected[key]);
		});
	},
);
