import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

describe("native numeric switch certificate", () => {
	it("survives artifact encoding and validates the original strict dispatch edges", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				readFileSync("tests/local/numeric-switch-dispatch.js", "utf8"),
				"switch-contract.js",
			),
		);
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const native = decoded.native.functions.find(
			(fn) => (fn.numericSwitches?.length ?? 0) > 0,
		)!;
		expect(native.numericSwitches).toEqual(
			image.native.functions[native.functionIndex]!.numericSwitches,
		);
		const fn = decoded.runtime.functions[native.functionIndex]!;
		const emitted = emitCompiledFunction(fn, native, native.functionIndex, "", false)!;
		expect(emitted.source).toContain("switch ((i32)");
		const malformed = {
			...native,
			numericSwitches: native.numericSwitches!.map((site) => ({
				...site,
				cases: site.cases.map((label, i) =>
					i === 0 ? { ...label, targetIp: site.endIp } : label,
				),
			})),
		};
		expect(() =>
			emitCompiledFunction(fn, malformed, native.functionIndex, "", false),
		).toThrow(/switch certificate/);
		expect(() =>
			serializeCompilerArtifact({
				...decoded,
				native: {
					...decoded.native,
					functions: decoded.native.functions.map((row) =>
						row === native ? malformed : row,
					),
				},
			}),
		).toThrow(/switch certificate/);
	});
});
