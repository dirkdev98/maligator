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

const fixture = "tests/local/intl-datetime.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-intl-datetime-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const environments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
	(key) => process.env[key] === "1",
)
	? [{}]
	: [{}, STRESS_ENV];
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "intl-datetime",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		intlFeatures: ["date-time-format"],
	});
});
describe.each(["compiled", "interpreted"] as const)("%s DateTimeFormat", (backend) => {
	it("preserves bundled day-period separators and field boundaries", () => {
		for (const stress of environments)
			expect(
				runToStdout(pair[backend], {
					env: { TZ: "UTC", DATETIME_SCENARIO: "pinned", ...stress },
				}).trim(),
			).toBe('["ok"]');
	});
	it("canonicalizes explicit Unicode option values", () => {
		for (const stress of environments)
			expect(
				runToStdout(pair[backend], {
					env: { TZ: "UTC", DATETIME_SCENARIO: "canonical_options", ...stress },
				}).trim(),
			).toBe('["ok"]');
	});
	it.each([
		{
			scenario: "styles",
			behavior: "partitions styled dates and times into locale fields",
		},
		{
			scenario: "calendars",
			behavior: "preserves calendar fields and supplementary digits",
		},
		{
			scenario: "locale_methods",
			behavior: "keeps Date locale methods consistent with formatter preferences",
		},
		{
			scenario: "locale_protocol",
			behavior: "collects Date locale preferences once through getters",
		},
		{
			scenario: "locale_invalid",
			behavior: "validates styles after handling invalid Date values",
		},
		{
			scenario: "options",
			behavior: "applies supported options before locale extension preferences",
		},
		{
			scenario: "option_coercion",
			behavior: "collects calendar and digit options before styles",
		},
		{
			scenario: "invalid_options",
			behavior: "rejects malformed calendar and numbering options",
		},
		{
			scenario: "resolved",
			behavior: "reports the selected calendar and numbering system",
		},
		{
			scenario: "clipping",
			behavior: "clips timestamps before converting to civil fields",
		},
		{
			scenario: "invalid",
			behavior: "rejects timestamps outside the numeric date domain",
		},
		{ scenario: "brand", behavior: "checks the receiver before coercing the timestamp" },
		{
			scenario: "coercion",
			behavior: "retains formatter plans across collecting coercions",
		},
		{
			scenario: "range_coercion",
			behavior: "coerces both range endpoints before validating time",
		},
	])("$behavior", ({ scenario }) => {
		const env = { DATETIME_SCENARIO: scenario, TZ: "UTC", MAL_HOST_GC: "1" };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			env: { ...process.env, ...env },
		});
		for (const stress of environments)
			expect(runToStdout(pair[backend], { env: { ...env, ...stress } })).toBe(expected);
	});
});
