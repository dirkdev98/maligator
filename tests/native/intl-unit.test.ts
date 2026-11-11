import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

function parseRows(output: string): Array<unknown> {
	const parsed: unknown = JSON.parse(output);
	if (!Array.isArray(parsed)) throw new Error("Unit fixture output must be an array");
	return parsed;
}
const fixture = "tests/local/intl-unit.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-intl-unit-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const gcEnvironments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
	(key) => process.env[key] === "1",
)
	? [{}]
	: [{}, STRESS_ENV];
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "intl-unit",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		intlFeatures: ["number-format"],
	});
});
describe.each(["compiled", "interpreted"] as const)("%s unit formatting", (backend) => {
	it("preserves the percent denominator from pinned CLDR patterns", () => {
		for (const gcEnv of gcEnvironments)
			expect(
				parseRows(
					runToStdout(pair[backend], { env: { UNIT_SCENARIO: "pinned", ...gcEnv } }),
				),
			).toEqual(["ok"]);
	});
	it.each(["matrix", "protocol"])(
		"preserves %s through the public unit formatter",
		(scenario) => {
			const env = { UNIT_SCENARIO: scenario, MAL_HOST_GC: "1" };
			const expected = parseRows(
				execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
					maxBuffer: 8 * 1024 * 1024,
				}),
			);
			for (const gcEnv of gcEnvironments) {
				const actual = parseRows(
					runToStdout(pair[backend], { env: { ...env, ...gcEnv } }),
				);
				expect(actual).toHaveLength(expected.length);
				const differences = actual.flatMap((row: unknown, index: number) =>
					JSON.stringify(row) === JSON.stringify(expected[index])
						? []
						: [{ expected: expected[index], actual: row }],
				);
				expect(
					differences.slice(0, 20),
					`${differences.length} unit-output differences`,
				).toEqual([]);
			}
		},
	);
});
