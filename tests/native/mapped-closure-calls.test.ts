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

const fixture = "tests/local/mapped-closure-calls.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-mapped-closure-calls-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function expected(scenario: string) {
	return execFileSync(process.execPath, ["--expose-gc", fixture], {
		encoding: "utf8",
		env: { ...process.env, MAPPED_CLOSURE_CASE: scenario },
	});
}

describe("mapped closure calls", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let precise: string;
	let mutable: string;
	let realms: string;
	beforeAll(() => {
		const shared = { fixture, outDir };
		const config = resolveBuildConfig({
			engine: { eval: false, realms: false },
			surface: { node: true },
		});
		pair = buildBackendPairFromOneProgramImage({
			...shared,
			name: "mapped-closure-calls",
			config,
		});
		precise = buildNativeBinary({
			...shared,
			name: "mapped-closure-calls-precise",
			config,
			nativeStackRoots: "precise",
		});
		mutable = buildNativeBinary({
			...shared,
			name: "mapped-closure-calls-mutable",
			config: resolveBuildConfig({
				engine: { eval: false, realms: false, primordials: "mutable" },
				surface: { node: true },
			}),
		});
		realms = buildNativeBinary({
			...shared,
			name: "mapped-closure-calls-realms",
			config: resolveBuildConfig({
				engine: { eval: false, realms: true },
				surface: { node: true },
			}),
		});
	});
	it.each([
		["instances", "reads changing captures from each closure activation"],
		[
			"argumentGc",
			"retains the callee when arguments clear the source Array and collect",
		],
		["replacement", "calls replacement, bound and Proxy functions"],
		["accessor", "reads an indexed getter before evaluating arguments"],
		["missing", "evaluates arguments before reporting a non-callable element"],
		["coercion", "performs fallback coercion once and observes its capture writes"],
		["bigint", "preserves BigInt arithmetic errors"],
		["throwing", "propagates an exception from fallback coercion"],
		["numbers", "preserves signed zero, NaN and infinities"],
		["tdz", "preserves coercion before an uninitialized capture throws"],
	])("%s: %s", (scenario) => {
		const oracle = expected(scenario);
		for (const binary of [pair.compiled, pair.interpreted, precise])
			expect(
				runToStdout(binary, {
					env: { ...STRESS_ENV, MAPPED_CLOSURE_CASE: scenario, MAL_HOST_GC: "1" },
				}),
			).toBe(oracle);
	});
	it("observes a mutable Array.from replacement", () => {
		expect(
			runToStdout(mutable, {
				env: { ...STRESS_ENV, MAPPED_CLOSURE_CASE: "mutable", MAL_HOST_GC: "1" },
			}),
		).toBe(expected("mutable"));
	});
	it("preserves closure environments with realm support enabled", () => {
		expect(
			runToStdout(realms, {
				env: { ...STRESS_ENV, MAPPED_CLOSURE_CASE: "instances", MAL_HOST_GC: "1" },
			}),
		).toBe(expected("instances"));
	});
});
