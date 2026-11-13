import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-global-dynamic-code-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// The product default: locked primordials and one realm, with the run-time compiler.
const config = resolveBuildConfig({ engine: { eval: true } });

function expectNodeOutput(fixture: string, name: string): ProgramImage {
	const pair = buildBackendPairFromOneProgramImage({ fixture, name, outDir, config });
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	for (const binary of [pair.compiled, pair.interpreted]) {
		expect(runToStdout(binary)).toBe(expected);
		expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 180_000 })).toBe(expected);
	}
	return pair.programImage;
}

function opcodes(image: ProgramImage, name: string): ReadonlySet<string> {
	const fn = image.runtime.functions.find(
		(candidate) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[candidate.nameStringIndex] ?? []),
			) === name,
	);
	expect(fn, name).toBeDefined();
	return new Set(fn!.instructions.map((instruction) => instruction.opcode));
}

describe("run-time code in a program that keeps source closure", () => {
	it(
		"sees only the global object and the values the program hands it",
		() => {
			const image = expectNodeOutput(
				"tests/local/global-dynamic-code.mjs",
				"global-dynamic-code",
			);
			// The lowered private rest loop shows the build kept its closed-world passes.
			expect(opcodes(image, "privateRest").has("GET_ITERATOR")).toBe(false);
		},
		scaledNativeRunTimeoutMs(600_000, STRESS_ENV),
	);

	it(
		"reads and writes the locals, captures and private fields a direct eval names",
		() => expectNodeOutput("tests/local/direct-eval-module.mjs", "direct-eval-module"),
		scaledNativeRunTimeoutMs(600_000, STRESS_ENV),
	);

	it(
		"optimizes what no direct eval sees while each eval reaches its own scopes",
		() => {
			const image = expectNodeOutput(
				"tests/local/direct-eval-scope/main.mjs",
				"direct-eval-scope",
			);
			// Fused generator traversal and lowered rest loops iterate without the protocol.
			for (const name of ["sumRanges", "restTotal", "restUnseen"])
				expect(opcodes(image, name).has("GET_ITERATOR"), name).toBe(false);
			expect(opcodes(image, "restSeen").has("GET_ITERATOR")).toBe(true);
		},
		scaledNativeRunTimeoutMs(600_000, STRESS_ENV),
	);

	it(
		"optimizes what no CommonJS direct eval sees while each eval reaches its module's wrapper bindings",
		() => {
			const image = expectNodeOutput(
				"tests/local/direct-eval-cjs/main.cjs",
				"direct-eval-cjs",
			);
			for (const name of ["sumRanges", "restTotal", "restUnseen"])
				expect(opcodes(image, name).has("GET_ITERATOR"), name).toBe(false);
			expect(opcodes(image, "restSeen").has("GET_ITERATOR")).toBe(true);
		},
		scaledNativeRunTimeoutMs(600_000, STRESS_ENV),
	);
});
