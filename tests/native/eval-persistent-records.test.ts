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

const fixture = "tests/local/eval-persistent-records.cjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-eval-records-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("persistent direct eval records", () => {
	let expected: Record<string, unknown>;
	const outputs: Array<Record<string, unknown>> = [];
	beforeAll(() => {
		expected = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as Record<string, unknown>;
		const binaries = buildBackendPairFromOneProgramImage({
			fixture,
			name: "eval-records",
			outDir,
			config: resolveBuildConfig({ engine: { eval: true }, surface: { node: true } }),
		});
		const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		);
		for (const binary of [binaries.compiled, binaries.interpreted])
			for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
				outputs.push(JSON.parse(runToStdout(binary, { env })) as Record<string, unknown>);
	});
	const cases = {
		nestedDeletion: "observes a nested eval deleting the original variable",
		redeclaration: "recreates a deleted variable during nested declaration instantiation",
		escapedBindings:
			"keeps escaped reads and writes attached to the live variable record",
		nestedAbrupt:
			"retains nested writes and thrown identity before deleting the variable",
		ordinaryFunction: "gives an eval-created ordinary function its own variable record",
		arrowFunction: "gives an eval-created arrow its own variable record",
		parameterVariables:
			"keeps parameter eval variables separate from body-only declarations",
	};
	for (const [key, name] of Object.entries(cases))
		it(name, () => {
			for (const output of outputs) expect(output[key]).toEqual(expected[key]);
		});
});
