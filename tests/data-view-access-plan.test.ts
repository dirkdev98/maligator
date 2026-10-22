import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";

function compile(primordials: "mutable" | "locked") {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.read = function (view, offset) { return view.getUint32(offset, true) + view.getInt8(0); };
			globalThis.write = function (view, offset, value) { view.setFloat64(offset, value); };
			globalThis.wide = function (view) { return view.getBigInt64(0); };`,
			"/data-view.js",
		),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials, eval: false, realms: false } }),
				),
				programClosureCertificate(
					{ kind: "whole-program", entry: "/data-view.js" },
					[],
					[],
				),
			),
		},
	);
}

describe("DataView accessor calls", () => {
	it.each(["mutable", "locked"] as const)(
		"guard numeric accessors on the loaded method with %s primordials",
		(mode) => {
			const image = compile(mode);
			const operations = image.native.functions.flatMap((fn) =>
				fn.instructions.flatMap((plan) =>
					plan?.kind === "call" && plan.guardedBuiltinCall !== undefined
						? [plan.guardedBuiltinCall.operation]
						: [],
				),
			);
			expect(operations.sort()).toEqual([
				"DataView.prototype.getInt8",
				"DataView.prototype.getUint32",
				"DataView.prototype.setFloat64",
			]);
			expect(
				deserializeCompilerArtifact(serializeCompilerArtifact(image)).native.functions,
			).toEqual(image.native.functions);
		},
	);
});
