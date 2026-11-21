import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
function config(primordials: "mutable" | "locked") {
	return resolveBuildConfig({
		engine: { primordials, eval: false, realms: false },
	});
}
function named(
	image: ReturnType<typeof compileSemanticProgramToProgramImage>,
	name: string,
) {
	return image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === name,
	)!;
}
describe("bundled span numeric parsers", () => {
	it.each(["mutable", "locked"] as const)(
		"selects both parsers for every bundled span source under %s primordials",
		(mode) => {
			const buildConfig = config(mode);
			const image = compileSemanticProgramToProgramImage(
				loadEntrypointAndRunSemanticAnalysis(
					resolve("tests/local/string-span-parsers.js"),
					{ buildConfig, stripTypes: stripCompactTypes },
				),
				{ facts: compilerProgramFactsFromConfig(buildConfig) },
			);
			for (const name of [
				"parseRange",
				"parseSplit",
				"parseCapture",
				"parseNested",
				"parseBounded",
			]) {
				const fn = named(image, name);
				const kinds = [
					...fn.specializations.flatMap((r) =>
						r.kind === "string-span" ? r.consumers : [],
					),
					...fn.storage!.spanContinuations.flatMap((p) => p.consumers),
				].map((c) => c.kind);
				expect(kinds, name).toEqual(expect.arrayContaining(["parseInt", "parseFloat"]));
				expect(
					emitCompiledFunction(fn, fn.functionIndex, "", false)!.source,
					name,
				).toContain("mal_builtin_number_span_parse");
			}
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
		},
	);
});
