import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, primordials: "mutable" | "locked" = "mutable") {
	return lowerNativeStorage(
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.scan = function(text, observer, prefix) {
					if(typeof text !== "string") throw new TypeError("string required");
					${body}
				};`,
				"/string-scan.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials } }),
				),
			},
		),
		"conservative",
	);
}

describe("pure String scan admission", () => {
	it("selects the copy and state-machine paths in the observable native fixture", () => {
		const image = lowerNativeStorage(
			compileEntrypoint("tests/local/string-scan.mjs", {
				buildConfig: resolveBuildConfig({ engine: { primordials: "mutable" } }),
				enforcePolicies: false,
				coreInstrumentation: "off",
			}),
			"conservative",
		);
		for (const name of ["copy", "segments"]) {
			const index = image.runtime.functions.findIndex(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
					) === name,
			);
			expect(index).toBeGreaterThanOrEqual(0);
			const emitted = emitCompiledFunction(
				image.native.functions[index]!,
				index,
				"",
				false,
				"static",
				new Set(),
				[],
				new Map(),
				false,
				new Set(),
				image.runtime.stringConstants,
			);
			expect(emitted?.source, name).toContain("__string_scan_");
		}
	});
	it.each(["mutable", "locked"] as const)(
		"retains the copy-loop shortcut through artifact serialization with %s primordials",
		(primordials) => {
			const image = compile(
				`let result = ""; for (const character of text) {
					if (character === "!") throw new Error("sentinel");
					result += character;
				} return result;`,
				primordials,
			);
			const source = emitProgramImage(image, { compiled: true });
			expect(source).toContain("__string_scan_");
			expect(
				emitProgramImage(deserializeCompilerArtifact(serializeCompilerArtifact(image)), {
					compiled: true,
				}),
			).toBe(source);
		},
	);

	it.each([
		[
			"a visible counter",
			`let result="", count=0; for(const character of text){count++;result+=character;}return [result,count];`,
		],
		[
			"a call on the copied path",
			`let result=""; for(const character of text){observer(character);result+=character;}return result;`,
		],
		[
			"a reset on every iteration",
			`let result=""; for(const character of text){result="";result+=character;}return result;`,
		],
		[
			"two copies of each character",
			`let result=""; for(const character of text){result+=character;result+=character;}return result;`,
		],
		[
			"an existing prefix",
			`let result=prefix; for(const character of text){result+=character;}return result;`,
		],
		[
			"a visible last character",
			`let result="", last=""; for(const character of text){result+=character;last=character;}return [result,last];`,
		],
	])("keeps ordinary execution for %s", (_name, body) => {
		expect(emitProgramImage(compile(body), { compiled: true })).not.toContain(
			"__string_scan_",
		);
	});
});
