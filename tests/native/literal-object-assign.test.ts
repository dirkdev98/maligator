import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/literal-object-assign.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-literal-assign-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const commonjsFixture = join(outDir, "literal-object-assign.cjs");
writeFileSync(commonjsFixture, readFileSync(fixture, "utf8"));
function expected(scenario: string, fixture: string) {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, LITERAL_ASSIGN_CASE: scenario },
	});
}
describe.each([fixture, commonjsFixture])("literal Object.assign in %s", (fixture) => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let sloppy: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let mutable: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false },
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
		mutable = buildBackendPairFromOneProgramImage({
			fixture,
			name: "literal-assign-mutable",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: false, realms: false },
			}),
		});
	});
	const scenarios = [
		["freshCopies", "copies dynamic sources into fresh objects in property order"],
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
	] as const;
	it.each(scenarios)("%s: %s", (scenario) => {
		const oracle = expected(scenario, fixture);
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: { LITERAL_ASSIGN_CASE: scenario } })).toBe(
				oracle,
			);
	});
	it.each([
		...scenarios,
		[
			"literalSetterMutation",
			"finishes the captured assign when an earlier setter patches it",
		],
		["assignReplacedBeforeFirst", "observes assign replaced before the first call"],
		["assignReplacedAfterWarmup", "observes assign replaced after the first call"],
		["assignArgumentMutation", "calls the method captured before argument evaluation"],
		["assignGetterMutation", "observes assign replaced by a getter"],
		[
			"assignSourceGetterMutation",
			"finishes the captured copy after a source getter patches assign",
		],
		["namespaceReplacedAfterWarmup", "observes the replaced global Object binding"],
		["hasOwnReplacedBeforeFirst", "observes hasOwn replaced before the first call"],
		["hasOwnReplacedAfterWarmup", "observes hasOwn replaced after the first call"],
		["hasOwnKeyMutation", "finishes hasOwn after key conversion patches its binding"],
		["objectPrototypeSetter", "invokes a setter added to Object.prototype"],
		["freshSetterAfterWarmup", "observes a new inherited setter on a fresh target"],
		[
			"objectPrototypeSetterAfterWarmup",
			"invokes an Object.prototype setter added after the same shapes merged",
		],
		["objectPrototypeReadonly", "throws for a key Object.prototype made nonwritable"],
		["objectPrototypeField", "shadows a writable field added to Object.prototype"],
	] as const)("%s with mutable primordials: %s", (scenario) => {
		const oracle = expected(scenario, fixture);
		for (const binary of [mutable.compiled, mutable.interpreted]) {
			expect(runToStdout(binary, { env: { LITERAL_ASSIGN_CASE: scenario } })).toBe(
				oracle,
			);
			expect(
				runToStdout(binary, { env: { ...STRESS_ENV, LITERAL_ASSIGN_CASE: scenario } }),
			).toBe(oracle);
		}
	});
	it.each(["setters", "throw", "proxy", "objects", "specialValues", "freshCopies"])(
		"roots %s values across collecting stores",
		(scenario) => {
			const oracle = expected(scenario, fixture);
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
		for (const binary of [mutable.compiled, mutable.interpreted])
			expect(runToStdout(binary, { env: { LITERAL_ASSIGN_CASE: "mutable" } })).toBe(
				expected("mutable", fixture),
			);
	});
	it("observes foreign values and replaced foreign builtins with realms enabled", () => {
		const realmFixture = "tests/local/mutable-object-guards-realms.mjs";
		const realms = buildBackendPairFromOneProgramImage({
			fixture: realmFixture,
			name: "mutable-object-guards-realms",
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", realms: true, eval: true },
			}),
		});
		const oracle = execFileSync(process.execPath, [realmFixture], { encoding: "utf8" });
		for (const binary of [realms.compiled, realms.interpreted]) {
			expect(runToStdout(binary)).toBe(oracle);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(oracle);
		}
	});
});
