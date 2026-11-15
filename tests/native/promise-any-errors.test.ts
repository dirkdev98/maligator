import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/promise-any-errors.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-promise-any-errors-"));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "promise-any-errors",
		outDir,
		config: resolveBuildConfig({
			engine: { primordials: "mutable" },
			surface: { node: true },
		}),
	});
});
it.each([
	["rejected", "publishes rejection reasons without consulting a late Array iterator"],
	["empty", "creates empty rejection reasons without consulting the Array iterator"],
	[
		"constructor",
		"observes the iterable passed to the public AggregateError constructor",
	],
])("%s: %s", (scenario) => {
	const env = { PROMISE_ANY_ERRORS_CASE: scenario };
	const expected = execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	for (const target of [pair.compiled, pair.interpreted]) {
		expect(runToStdout(target, { env })).toBe(expected);
		expect(runToStdout(target, { env: { ...STRESS_ENV, ...env } })).toBe(expected);
	}
});
