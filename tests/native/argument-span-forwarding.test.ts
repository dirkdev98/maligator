import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { preparedNativeEvalConfig } from "../helpers/native-eval-config.ts";

const fixture = "tests/local/argument-span-forwarding.cjs";
const scenarios = execFileSync(process.execPath, [fixture], {
	encoding: "utf8",
	env: { ...process.env, ARGUMENT_SPAN_CASE: "list" },
})
	.trim()
	.split("\n");

describe("argument span forwarding with mutable primordials and realms", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-argument-span-forwarding-"));
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "argument-span-forwarding",
			outDir,
			config: preparedNativeEvalConfig(),
		});
	});
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	it.each(scenarios)("preserves %s on both backends and under GC stress", (scenario) => {
		const env = { ARGUMENT_SPAN_CASE: scenario, MAL_HOST_GC: "1" };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { env })).toBe(expected);
			expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
		}
	});
});
