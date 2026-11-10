import { resolve } from "node:path";
import { expect, it } from "vitest";
import { runtimeGapBuildConfig } from "../scripts/runtime-gap-build-config.ts";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";

it("keeps transfer-only blocks valid during guarded Array expansion", () => {
	const image = compileEntrypoint(resolve("bench/runtime-gap/cases/array-map.mjs"), {
		buildConfig: runtimeGapBuildConfig(),
	});
	const arrayMap = image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "arrayMap",
	);
	expect(
		arrayMap?.specializations.some((region) => region.kind === "indexed-length-loop"),
	).toBe(true);
});

it.each([
	[
		"numeric continuation",
		"let total = 0; for (let index = 0; index < limit; index++) total = (total + reader.read(index)) | 0; return total;",
		true,
	],
	[
		"shared result",
		"let total = 0; for (let index = 0; index < limit; index++) { const result = reader.read(index); total = (total + result) | 0; globalThis.seen = result; } return total;",
		false,
	],
	[
		"exception handler",
		"let total = 0; try { for (let index = 0; index < limit; index++) total = (total + reader.read(index)) | 0; } catch { return -1; } return total;",
		false,
	],
] as const)("bounds guarded arithmetic across a %s", (_name, body, admitted) => {
	let edits = 0;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`
		class Reader {
			constructor() { this.bias = 3; }
			read(value) { return (value + this.bias) & 255; }
		}
		const reader = new Reader();
		function compute(value) { const limit = value & 255; ${body} }
		globalThis.reader = reader;
		globalThis.compute = compute;
	`,
			"/guarded-continuation.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: "mutable" } }),
			),
			coreInstrumentation: "full",
			afterCoreOptimization(_program, _context, report) {
				edits =
					report.passes.find(
						({ pass }) => pass === "guarded-call-arithmetic-continuation",
					)?.edits ?? 0;
			},
		},
	);
	expect(edits > 0).toBe(admitted);
});

it("continues arithmetic through nested guarded method joins", () => {
	let edits = 0;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`
		class Reader { read(value) { return (value + 3) & 255; } }
		class Other { read(value) { return (value - 7) & 255; } }
		const readers = [new Reader(), new Other()];
		function compute(limit) {
			let total = 0;
			for (let index = 0; index < limit; index++) total = (total + readers[index & 1].read(index)) | 0;
			return total;
		}
		globalThis.readers = readers;
		globalThis.compute = compute;
	`,
			"/nested-guarded-continuation.js",
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials: "mutable" } }),
			),
			coreInstrumentation: "full",
			afterCoreOptimization(_program, _context, report) {
				edits =
					report.passes.find(
						({ pass }) => pass === "guarded-call-arithmetic-continuation",
					)?.edits ?? 0;
			},
		},
	);
	expect(edits).toBeGreaterThan(0);
});
