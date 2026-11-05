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

const fixture = "tests/local/rest-iteration.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-rest-iteration-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function expected(scenario: string) {
	return execFileSync(process.execPath, ["--expose-gc", fixture], {
		encoding: "utf8",
		env: { ...process.env, REST_ITERATION_CASE: scenario },
	});
}

describe("private rest iteration", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let precise: string;
	let mutable: string;
	beforeAll(() => {
		const shared = { fixture, outDir };
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false },
			surface: { node: true },
		});
		pair = buildBackendPairFromOneProgramImage({
			...shared,
			name: "rest-iteration",
			config,
		});
		precise = buildNativeBinary({
			...shared,
			name: "rest-iteration-precise",
			config,
			nativeStackRoots: "precise",
		});
		mutable = buildNativeBinary({
			...shared,
			name: "rest-iteration-mutable",
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: false, realms: false },
				surface: { node: true },
			}),
		});
	});
	it.each([
		["numbers", "preserves empty rest and IEEE Number arithmetic"],
		["coercion", "coerces each value once in iteration order"],
		["throw", "propagates coercion and mixed BigInt exceptions"],
		["gc", "retains future rest objects through collection"],
		["exits", "releases argument roots on break and return"],
		["repeated", "restarts an inner rest iterator on each outer iteration"],
		["escape", "observes writes and escaped rest arrays"],
		["forward", "unlinks virtual and forwarded argument roots in reverse order"],
		["delayed", "retains rest values across fused numeric loop polls"],
		["joins", "preserves different values carried by branch and continue edges"],
	])("%s: %s", (scenario) => {
		const oracle = expected(scenario);
		for (const binary of [pair.compiled, pair.interpreted, precise])
			expect(
				runToStdout(binary, {
					env: { ...STRESS_ENV, REST_ITERATION_CASE: scenario, MAL_HOST_GC: "1" },
				}),
			).toBe(oracle);
	});
	it("observes a mutable iterator and its return method", () => {
		expect(
			runToStdout(mutable, {
				env: { ...STRESS_ENV, REST_ITERATION_CASE: "mutable", MAL_HOST_GC: "1" },
			}),
		).toBe(expected("mutable"));
	});
});
