import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";

describe("compileSemanticProgramToProgramImage", () => {
	it("runs phases in order and inspects optimized IR before allocation", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis("1 + 2", "pipeline.js");
		const events: Array<string> = [];

		const definition = compileSemanticProgramToProgramImage(semantic, {
			runPhase: (phase, run) => {
				events.push(`start:${phase}`);
				const result = run();
				events.push(`end:${phase}`);
				return result;
			},
			afterCoreOptimization: () => events.push("after optimization"),
		});

		expect(definition.runtime.functions.length).toBeGreaterThan(0);
		expect(events).toEqual([
			"start:construct core ir",
			"end:construct core ir",
			"start:core ir optimizations",
			"end:core ir optimizations",
			"after optimization",
			"start:lower core ir",
			"end:lower core ir",
			"start:lower to vm",
			"end:lower to vm",
		]);
	});

	it("forwards eval lowering options", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis("value", "eval");
		const definition = compileSemanticProgramToProgramImage(semantic, {
			semanticLowering: { evalCompletion: true, evalDirect: true },
		});

		expect(definition.runtime.functions.length).toBeGreaterThan(0);
	});

	it("supports the correctness-focused development optimization profile", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"const answer = 40 + 2; answer",
			"development.js",
		);

		const definition = compileSemanticProgramToProgramImage(semantic, {
			optimization: "development",
		});

		expect(definition.runtime.functions.length).toBeGreaterThan(0);
		expect(definition.runtime.functionCount).toBe(definition.runtime.functions.length);
	});

	it("routes optimized production IR through Core", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`
			function invoke(fn, C, flag) {
				try {
					if (flag) return fn(undefined, null, false, 42, "value");
					return new C(undefined, "value", 7);
				} catch (error) {
					return String(error);
				}
			}
			globalThis.invoke = invoke;
			`,
			"production-core-verification.js",
		);

		expect(() =>
			compileSemanticProgramToProgramImage(semantic, {
				optimization: "full",
			}),
		).not.toThrow();
	});
});
