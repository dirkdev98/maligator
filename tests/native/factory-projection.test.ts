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

const fixture = "tests/local/factory-projection.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-factory-projection-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("factory projection materialization", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let expected: Record<string, unknown>;
	beforeAll(() => {
		expected = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as Record<string, unknown>;
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "factory-projection",
			outDir,
			config: resolveBuildConfig({}),
		});
		const consumed = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "consumeGraphs",
		);
		expect(consumed).toBeDefined();
		expect(
			consumed!.body.instructions.some((instruction) => instruction.opcode === "CALL"),
		).toBe(false);
	});
	it.each([
		{
			scenario: "retained",
			behavior: "preserves retained captures and independent record identities",
		},
		{ scenario: "consumed", behavior: "evaluates unretained closure results" },
		{
			scenario: "fallbacks",
			behavior: "preserves captured writes and coercion ordering",
		},
		{
			scenario: "repeated",
			behavior: "shares one identity across repeated observations",
		},
	])("$behavior", ({ scenario }) => {
		for (const binary of [pair.compiled, pair.interpreted])
			expect(
				(JSON.parse(runToStdout(binary)) as Record<string, unknown>)[scenario],
			).toEqual(expected[scenario]);
	});
	it("keeps retained graphs alive through collection", () => {
		for (const binary of [pair.compiled, pair.interpreted])
			expect(JSON.parse(runToStdout(binary, { env: STRESS_ENV }))).toEqual(expected);
	});
});
