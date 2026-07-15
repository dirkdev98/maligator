import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

describe("compileSemanticProgramToVmDefinition", () => {
	it("runs phases in order and inspects optimized IR before allocation", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis("1 + 2", "pipeline.js");
		const events: Array<string> = [];

		const definition = compileSemanticProgramToVmDefinition(semantic, {
			runPhase: (phase, run) => {
				events.push(`start:${phase}`);
				const result = run();
				events.push(`end:${phase}`);
				return result;
			},
			afterOptimization: () => events.push("after optimization"),
		});

		expect(definition.functions.length).toBeGreaterThan(0);
		expect(events).toEqual([
			"start:compile to ir",
			"end:compile to ir",
			"start:ir optimizations",
			"end:ir optimizations",
			"after optimization",
			"start:register allocation",
			"end:register allocation",
			"start:lower to vm",
			"end:lower to vm",
		]);
	});

	it("forwards eval IR options", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis("value", "eval");
		let observed: { evalCompletion: boolean; evalDirect: boolean } | undefined;

		compileSemanticProgramToVmDefinition(semantic, {
			ir: { evalCompletion: true, evalDirect: true },
			afterOptimization: (ir) => {
				observed = {
					evalCompletion: ir.evalCompletion,
					evalDirect: ir.evalDirect,
				};
			},
		});

		expect(observed).toEqual({ evalCompletion: true, evalDirect: true });
	});
});
