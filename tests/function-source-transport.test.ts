import { expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToRuntimeImage } from "../src/compiler/pipeline/compile-runtime-core.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";

it("omits function implementation text from runtime images without debug information", () => {
	const marker = "fictional source-only marker";
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		`globalThis.add = function add(value) { /* ${marker} */ return value + 1; };`,
		"reflection.js",
	);
	const runtime = deserializeRuntimeImage(
		serializeRuntimeImage(compileSemanticProgramToRuntimeImage(semantic), {
			debugInfo: false,
		}),
	);
	for (const text of runtime.stringConstants)
		expect(String.fromCharCode(...text)).not.toContain(marker);
});
