import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { CORE_STRING_METHOD_CHAIN_OPERATIONS } from "../../src/compiler/core/core-ir-regions.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const fixture = "tests/local/guarded-string-methods.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-guarded-string-methods-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function oracle(env: Record<string, string>): string {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

function guardedOperations(pair: BackendPairResult): ReadonlySet<string> {
	return new Set(
		pair.programImage.native.functions.flatMap((fn) =>
			fn.instructions.flatMap((plan) =>
				plan?.kind === "call" && plan.guardedBuiltinCall !== undefined
					? [plan.guardedBuiltinCall.operation]
					: [],
			),
		),
	);
}

function stringMethodChains(pair: BackendPairResult): ReadonlySet<string> {
	return new Set(
		pair.programImage.native.functions.flatMap((fn) =>
			fn.specializations.flatMap((region) =>
				region.kind === "string-method-chain" ? [region.operation] : [],
			),
		),
	);
}

describe.each<{ primordials: "locked" | "mutable"; env: Record<string, string> }>([
	{ primordials: "locked", env: {} },
	{ primordials: "mutable", env: { GUARDED_STRING_PATCH: "1" } },
])(
	"String and RegExp methods on unknown receivers with $primordials primordials",
	({ primordials, env }) => {
		let pair: BackendPairResult;
		beforeAll(() => {
			pair = buildBackendPairFromOneProgramImage({
				fixture,
				outDir,
				name: `guarded-string-methods-${primordials}`,
				config: resolveBuildConfig({ engine: { primordials } }),
			});
		});

		it("tests the loaded method against the String and RegExp builtins", () => {
			const operations = guardedOperations(pair);
			for (const operation of [
				"String.prototype.toLowerCase",
				"String.prototype.slice",
				"Array.prototype.indexOf",
				"RegExp.prototype.exec",
			])
				expect(operations).toContain(operation);
		});

		it("runs each String method on a primitive string without loading the method", () => {
			const chains = stringMethodChains(pair);
			for (const operation of CORE_STRING_METHOD_CHAIN_OPERATIONS)
				if (operation !== "String.prototype.charCodeAt")
					expect(chains).toContain(operation);
		});

		it("matches Node on both backends", () => {
			const expected = oracle(env);
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary, { env })).toBe(expected);
				expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
			}
		});
	},
);
