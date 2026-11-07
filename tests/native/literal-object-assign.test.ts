import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/literal-object-assign.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-literal-assign-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function expected(scenario: string) {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, LITERAL_ASSIGN_CASE: scenario },
	});
}
describe("literal Object.assign", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let sloppy: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let mutable: string;
	beforeAll(() => {
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false },
			surface: { node: true },
		});
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "literal-assign",
			outDir,
			config,
		});
		sloppy = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/literal-object-assign-sloppy.cjs",
			entryGoal: "script",
			name: "literal-assign-sloppy",
			outDir,
			config,
		});
		mutable = buildNativeBinary({
			fixture,
			name: "literal-assign-mutable",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: false, realms: false },
				surface: { node: true },
			}),
		});
	});
	it.each([
		["ordinary", "copies fields and returns the original target"],
		["setters", "evaluates field values before invoking ordered inherited setters"],
		["throw", "retains earlier writes and skips later setters after a throw"],
		["frozen", "throws when an existing target field is nonwritable"],
		["proxy", "invokes Proxy setters with their original receiver"],
		["refused", "throws when a Proxy refuses a store"],
		["primitive", "boxes primitive targets"],
		["accessors", "reads source getters in own-key order"],
		["escaped", "observes changes to later fields of an escaped source"],
		["objects", "retains object field identities"],
		["specialValues", "preserves Number and BigInt values"],
		["keys", "preserves integer and Symbol enumeration"],
		["prototype", "invokes the inherited prototype setter"],
		["plainSources", "copies plain data sources in order without aliasing them"],
		["hiddenTarget", "keeps a nonenumerable target field nonenumerable"],
		["sharedPrototype", "reaches objects that inherit from the target"],
	])("%s: %s", (scenario) => {
		const oracle = expected(scenario);
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: { LITERAL_ASSIGN_CASE: scenario } })).toBe(
				oracle,
			);
	});
	it.each(["setters", "throw", "proxy", "objects", "specialValues"])(
		"roots %s values across collecting stores",
		(scenario) => {
			const oracle = expected(scenario);
			for (const binary of [pair.compiled, pair.interpreted])
				expect(
					runToStdout(binary, { env: { ...STRESS_ENV, LITERAL_ASSIGN_CASE: scenario } }),
				).toBe(oracle);
		},
	);
	it("keeps throwing Set in a sloppy caller", () => {
		const oracle = execFileSync(
			process.execPath,
			["tests/local/literal-object-assign-sloppy.cjs"],
			{ encoding: "utf8" },
		);
		for (const binary of [sloppy.compiled, sloppy.interpreted])
			expect(runToStdout(binary)).toBe(oracle);
	});
	it("calls a mutable assign override", () => {
		expect(runToStdout(mutable, { env: { LITERAL_ASSIGN_CASE: "mutable" } })).toBe(
			expected("mutable"),
		);
	});
});
