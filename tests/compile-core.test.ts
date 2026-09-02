import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileSemanticProgramToRuntimeImage } from "../src/compiler/pipeline/compile-runtime-core.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";

describe("compileSemanticProgramToProgramImage", () => {
	it("keeps instrumentation modes output-identical", () => {
		const source = `
			function add(left, right) { return left + right; }
			globalThis.answer = add(40, 2);
		`;
		const compile = (coreInstrumentation: "off" | "counters" | "full") => {
			let report: CoreOptimizationReport | undefined;
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, "instrumentation.js"),
				{
					coreInstrumentation,
					afterCoreOptimization(_program, _context, optimizationReport) {
						report = optimizationReport;
					},
				},
			);
			if (report === undefined) throw new Error("missing optimization report");
			return { image, report };
		};

		const off = compile("off");
		const counters = compile("counters");
		const full = compile("full");

		expect(counters.image).toEqual(off.image);
		expect(full.image).toEqual(off.image);
		expect(off.report).toMatchObject({
			instrumentation: "off",
			stages: [],
			passes: [],
			analyses: [],
			input: { functions: 0 },
		});
		expect(Object.values(off.report.counters).every((value) => value === 0)).toBe(true);
		expect(counters.report.instrumentation).toBe("counters");
		expect(counters.report.stages.length).toBeGreaterThan(0);
		expect(counters.report.passes).toEqual([]);
		expect(counters.report.analyses).toEqual([]);
		expect(counters.report.counters.localRulesConsidered).toBeGreaterThan(0);
		expect(counters.report.counters.analysisQueries).toBeGreaterThan(0);
		expect(counters.report.counters.localFactRebuilds).toBeGreaterThan(0);
		expect(counters.report.counters.provenanceRebuilds).toBeGreaterThan(0);
		expect(counters.report.counters.memoryLocations).toBeGreaterThan(0);
		expect(counters.report.counters.liveUseVisits).toBeGreaterThan(0);
		expect(counters.report.counters.storedCallGraphEntries).toBeGreaterThan(0);
		expect(counters.report.program.summaryFunctionsAnalyzed).toBeGreaterThanOrEqual(0);
		expect(counters.report.program.reachabilityFunctionsScanned).toBeGreaterThanOrEqual(
			0,
		);
		expect(counters.report.program.sccNodesAnalyzed).toBeGreaterThanOrEqual(0);
		expect(counters.report.program.sccEdgeVisits).toBeGreaterThanOrEqual(0);
		expect(full.report.instrumentation).toBe("full");
		expect(full.report.passes.length).toBeGreaterThan(0);
		expect(full.report.analyses.length).toBeGreaterThan(0);
	});

	it("runs phases in order and inspects optimized IR before target lowering", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis("1 + 2", "pipeline.js");
		const events: Array<string> = [];
		let instrumentation: string | undefined;

		const definition = compileSemanticProgramToProgramImage(semantic, {
			runPhase: (phase, run) => {
				events.push(`start:${phase}`);
				const result = run();
				events.push(`end:${phase}`);
				return result;
			},
			afterCoreOptimization: (program, _context, report) => {
				expect(program.sealed).toBe(true);
				instrumentation = report.instrumentation;
				events.push("after optimization");
			},
		});

		expect(definition.runtime.functions.length).toBeGreaterThan(0);
		expect(instrumentation).toBe("off");
		expect(events).toEqual([
			"start:construct core ir",
			"end:construct core ir",
			"start:optimize core ir",
			"end:optimize core ir",
			"after optimization",
			"start:core to execution",
			"end:core to execution",
			"start:execution to image",
			"end:execution to image",
		]);
	});

	it("forwards eval lowering options", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis("value", "eval");
		const definition = compileSemanticProgramToProgramImage(semantic, {
			semanticLowering: { evalCompletion: true, evalDirect: true },
		});

		expect(definition.runtime.functions.length).toBeGreaterThan(0);
	});

	it("keeps direct optimizer instrumentation off by default", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis("1 + 2", "direct.js");
		const result = optimizeCore(lowerSemanticProgramToCore(semantic));

		expect(result.report.instrumentation).toBe("off");
		expect(result.report.stages).toEqual([]);
	});

	it("seals the constructed store in place and records dense function relocation", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"function nested() { return 42; } globalThis.result = nested();",
			"empty-optimizer.js",
		);
		const constructed = lowerSemanticProgramToCore(semantic);
		const mutableProgram = constructed.program;
		const { compilation, report } = optimizeCore(constructed, {
			instrumentation: "full",
		});

		expect(compilation.program).toBe(mutableProgram);
		expect(compilation.program.sealed).toBe(true);
		expect(compilation.plan).toMatchObject({
			liveFunctions: [...compilation.program.functionIds()],
			directEntries: [],
			recipes: { count: 0 },
		});
		expect(compilation.plan.version.key).toMatch(/^p:/);
		expect(compilation.plan.statistics).toMatchObject({ applied: 0, declined: 0 });
		expect(report.output.functions).toBe(report.input.functions);
		expect(report.output.instructions).toBeLessThanOrEqual(report.input.instructions);
		expect(report.output.planCandidates).toBe(0);
		expect(report.stages.map(({ stage }) => stage)).toEqual([
			"canonicalize",
			"control-flow",
			"proofs",
			"memory",
			"finalize",
			"interprocedural",
			"program",
			"specialization",
		]);

		const execution = lowerCoreCompilationToExecutionProgram(compilation);
		expect(execution.functionMap.executionToCore).toEqual(compilation.plan.liveFunctions);
		for (const [index, core] of execution.functionMap.executionToCore.entries()) {
			expect(execution.functionMap.coreToExecution[core]).toBe(index);
		}
		expect(execution.functions.every((fn) => fn.functionIndex >= 0)).toBe(true);
		expect(execution.functions.every((fn) => fn.specializations.length === 0)).toBe(true);
		expect(execution.functions.every((fn) => fn.directEntries.length === 0)).toBe(true);
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

	it("gives runtime-wire and native products the same portable VM image", () => {
		const source = `
			function add(left, right) { return left + right; }
			let sum = 0;
			for (let index = 0; index < 100; index++) sum = add(sum, index);
			const record = { sum, label: "total" };
			globalThis.answer = record.sum + String(sum).length;
		`;
		const semantic = () =>
			analyzeSourceAndRunSemanticAnalysis(source, "runtime-terminal-parity.js");

		const portable = compileSemanticProgramToRuntimeImage(semantic());
		const native = compileSemanticProgramToProgramImage(semantic());

		expect(portable).toEqual(native.runtime);
	});
});
