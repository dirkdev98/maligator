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

const fixture = "tests/local/generator-fusion.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-generator-fusion-native-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each([
	{ primordials: "locked" as const, title: "private generator traversal" },
	{
		primordials: "mutable" as const,
		title: "private generator traversal behind a protocol guard",
	},
])("$title", ({ primordials }) => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let expected: Record<string, unknown>;
	beforeAll(() => {
		expected = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as Record<string, unknown>;
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `generator-fusion-${primordials}`,
			outDir,
			config: resolveBuildConfig({ engine: { primordials } }),
		});
	});
	it.each([
		{
			scenario: "traversal",
			behavior: "preserves repeated traversal, continue and break",
		},
		{ scenario: "sentValues", behavior: "resumes ordinary iteration with undefined" },
		{
			scenario: "exceptions",
			behavior: "propagates generator exceptions to the enclosing handler",
		},
		{
			scenario: "consumerExceptions",
			behavior: "preserves consumer exceptions during iteration",
		},
		{
			scenario: "consumerAllocation",
			behavior: "retains suspended state across allocating consumer calls",
		},
		{ scenario: "specialNumbers", behavior: "preserves signed zero, NaN and infinities" },
		{
			scenario: "earlyCompletion",
			behavior: "preserves initialization skipped by early completion",
		},
		{
			scenario: "prototypeObservation",
			behavior: "observes prototype mutation through another invocation",
		},
		{ scenario: "closing", behavior: "runs generator cleanup on early exit" },
		{ scenario: "coercion", behavior: "preserves argument coercion order" },
	])("$behavior", ({ scenario }) => {
		for (const binary of [pair.compiled, pair.interpreted])
			expect(
				(JSON.parse(runToStdout(binary)) as Record<string, unknown>)[scenario],
			).toEqual(expected[scenario]);
	});
	it("preserves traversal and fallback state through collection", () => {
		for (const binary of [pair.compiled, pair.interpreted])
			expect(JSON.parse(runToStdout(binary, { env: STRESS_ENV }))).toEqual(expected);
	});
});
