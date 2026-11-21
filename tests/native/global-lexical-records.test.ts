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

const fixture = "tests/local/global-lexical-records.cjs";
const expected = JSON.parse(
	execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
) as Record<string, unknown>;

describe("global lexical and object records", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-global-records-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	const outputs: Array<Record<string, unknown>> = [];
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "global-records",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: true, realms: true },
			}),
		});
		const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		);
		for (const binary of [pair.compiled, pair.interpreted])
			for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
				outputs.push(JSON.parse(runToStdout(binary, { env })) as Record<string, unknown>);
	});
	it.each(Object.keys(expected))("preserves %s", (key) => {
		for (const output of outputs) expect(output[key]).toEqual(expected[key]);
	});
});
