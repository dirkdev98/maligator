import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import { inputFactsFixture } from "../helpers/native-input-facts.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-input-facts-"));

describe("native operations selected by input representations", () => {
	it("preserves Number edges, UTF-16 operations and callee this across boxed result boundaries", () => {
		const { image: fixture, expected } = inputFactsFixture();
		const image = {
			...fixture,
			runtime: {
				...fixture.runtime,
				functions: fixture.runtime.functions.map((fn, index) =>
					index === 0 ? { ...fn, strict: true } : fn,
				),
			},
		};
		expect(
			emitCompiledFunction(
				image.runtime.functions[0]!,
				image.native.functions[0]!,
				0,
				"",
				false,
			),
		).not.toBeNull();
		const compiled = buildNativeProgramImage(image, {
			name: "input-facts",
			outDir,
			compiled: true,
			mainFile: "runtime/native_input_facts_test_main.c",
		});
		const actual = runToStdout(compiled, { env: STRESS_ENV }).trimEnd().split("\n");
		expect(actual.length).toBe(expected.length);
		for (let index = 0; index < expected.length; index++) {
			if (expected[index]!.startsWith("number ")) {
				expect(actual[index]).toMatch(/^number /);
				expect(Number(actual[index]!.slice(7))).toBe(Number(expected[index]!.slice(7)));
			} else expect(actual[index]).toBe(expected[index]);
		}
	});
});
