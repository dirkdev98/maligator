import { describe, expect, it } from "vitest";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import {
	CORE_MEMORY_SSA_PASSES,
	CORE_PROVENANCE_PASSES,
} from "../src/compiler/core/core-memory-passes.ts";
import { CORE_OPTIMIZATION_FAMILIES } from "../src/compiler/core/core-optimization-families.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compileSemanticProgramToRuntimeImage } from "../src/compiler/pipeline/compile-runtime-core.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";

function scanLiveStorage(program: CoreProgram) {
	const counts = {
		blocks: 0,
		instructions: 0,
		values: 0,
		uses: 0,
		operands: 0,
		blockParameters: 0,
		terminatorEdges: 0,
		terminatorArguments: 0,
		handlerArguments: 0,
		facts: 0,
		effectRefinements: 0,
	};
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		counts.blocks += [...fn.blockIds()].length;
		counts.instructions += [...fn.instructionIds()].length;
		counts.values += [...fn.valueIds()].length;
		counts.facts += [...fn.factIds()].length;
		for (const block of fn.blockIds()) {
			counts.blockParameters += fn.kernel.blockParameterCount(block);
			counts.handlerArguments += fn.kernel.blockHandlerArgumentCount(block);
		}
		for (const instruction of fn.instructionIds()) {
			counts.operands += fn.kernel.instructionOperandCount(instruction);
			const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
			const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
			counts.terminatorEdges += edgeCount;
			for (let edge = edgeStart; edge < edgeStart + edgeCount; edge++) {
				counts.terminatorArguments += fn.kernel.terminatorEdgeArgumentCount(edge);
			}
		}
		for (let use = 0; use < fn.useCapacity; use++) {
			if (fn.kernel.useLive(use) !== 0) counts.uses++;
		}
		for (let refinement = 0; refinement < fn.effectRefinementCapacity; refinement++) {
			if (fn.effectRefinementLive(refinement)) counts.effectRefinements++;
		}
	}
	return counts;
}

describe("compileSemanticProgramToProgramImage", () => {
	it("omits exactly one internal optimizer family per benchmark ablation", () => {
		const source = `
			function sum(values) {
				let total = 0;
				for (let index = 0; index < values.length; index++) total += values[index];
				return total;
			}
			globalThis.answer = sum([10, 20, 12]);
		`;
		const compile = (family: (typeof CORE_OPTIMIZATION_FAMILIES)[number]) => {
			let report: CoreOptimizationReport | undefined;
			let plan: CoreOptimizationPlan | undefined;
			const image = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(source, `ablate-${family}.js`),
				{
					coreInstrumentation: "full",
					coreOptimizationBenchmarkAblation: { family },
					afterCoreOptimization(program, _context, optimizationReport, optimizationPlan) {
						report = optimizationReport;
						plan = optimizationPlan;
						expect(program.sealed).toBe(true);
					},
				},
			);
			if (report === undefined || plan === undefined) {
				throw new Error("missing ablated optimizer result");
			}
			return { image, report, plan };
		};
		const passNames = (passes: ReadonlyArray<{ readonly name: string }>) =>
			new Set(passes.map(({ name }) => name));
		const passReportNames = (report: CoreOptimizationReport) =>
			new Set(report.passes.map(({ pass }) => pass));
		const intersects = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
			[...left].some((value) => right.has(value));

		for (const family of CORE_OPTIMIZATION_FAMILIES) {
			const { image, report, plan } = compile(family);
			const reported = passReportNames(report);
			expect(image.runtime.functions.length).toBeGreaterThan(0);
			switch (family) {
				case "o1-scalar-structural":
					expect(reported.has("fused-local-optimizer")).toBe(false);
					break;
				case "cfg-loop-licm-pre":
					expect(intersects(reported, passNames(CORE_CONTROL_FLOW_PASSES))).toBe(false);
					break;
				case "proof-value-kind-representation":
					expect(intersects(reported, passNames(CORE_PROOF_PASSES))).toBe(false);
					break;
				case "provenance-escape-scalar-replacement":
					expect(intersects(reported, passNames(CORE_PROVENANCE_PASSES))).toBe(false);
					break;
				case "memory-ssa-load-store":
					expect(intersects(reported, passNames(CORE_MEMORY_SSA_PASSES))).toBe(false);
					break;
				case "program-flow":
					expect(plan.liveFunctions).toHaveLength(report.output.functions);
					break;
				case "inlining-cross-call":
					expect(report.transforms).toMatchObject({ considered: 0, applied: 0 });
					break;
				case "late-specialization-direct-entry":
					expect(plan.statistics).toMatchObject({ considered: 0, applied: 0 });
					expect(plan.directEntries).toEqual([]);
					break;
			}
		}
	});

	it("keeps instrumentation modes output-identical", () => {
		const source = `
			function add(left, right) { return left + right; }
			globalThis.answer = add(40, 2);
		`;
		const compile = (coreInstrumentation: "off" | "phases" | "counters" | "full") => {
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
		const phases = compile("phases");
		const counters = compile("counters");
		const full = compile("full");

		expect(phases.image).toEqual(off.image);
		expect(counters.image).toEqual(off.image);
		expect(full.image).toEqual(off.image);
		expect(off.report).toMatchObject({
			instrumentation: "off",
			phases: [],
			checkpoints: [],
			passes: [],
			analyses: [],
			input: { functions: 0 },
		});
		expect(Object.values(off.report.counters).every((value) => value === 0)).toBe(true);
		expect(phases.report.instrumentation).toBe("phases");
		expect(phases.report.phases.length).toBe(17);
		expect(phases.report.checkpoints.length).toBe(8);
		expect(phases.report.passes).toEqual([]);
		expect(phases.report.analyses).toEqual([]);
		expect(Object.values(phases.report.counters).every((value) => value === 0)).toBe(
			true,
		);
		expect(counters.report.instrumentation).toBe("counters");
		expect(counters.report.phases).toEqual([]);
		expect(counters.report.checkpoints.length).toBe(8);
		expect(counters.report.passes).toEqual([]);
		expect(counters.report.analyses).toEqual([]);
		expect(counters.report.counters.localRulesConsidered).toBeGreaterThan(0);
		expect(counters.report.counters.analysisQueries).toBeGreaterThan(0);
		expect(counters.report.counters.localFactRebuilds).toBeGreaterThan(0);
		expect(counters.report.counters.provenanceRebuilds).toBeGreaterThan(0);
		expect(counters.report.counters.memoryLocations).toBe(0);
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
		expect(result.report.phases).toEqual([]);
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
		expect(compilation.plan.statistics).toMatchObject({
			applied: 0,
			declined: 0,
		});
		expect(report.output.functions).toBe(report.input.functions);
		expect(report.output.instructions).toBeLessThanOrEqual(report.input.instructions);
		expect(report.output.planCandidates).toBe(0);
		expect(report.phases.map(({ phase }) => phase)).toEqual([
			"pre-optimization-verification",
			"construction-cleanup",
			"initial-local-optimization",
			"structural-cfg-optimization",
			"dense-generation-barrier",
			"post-barrier-local-optimization",
			"advanced-cfg-optimization",
			"proof-and-representation-optimization",
			"memory-and-provenance-optimization",
			"late-local-cleanup",
			"program-flow",
			"cross-call-transforms",
			"specialization-discovery",
			"specialization-selection",
			"sealing",
			"plan-verification",
			"final-core-verification",
		]);
		expect(report.checkpoints.map(({ checkpoint }) => checkpoint)).toEqual([
			"after-core-construction",
			"after-initial-local-structural-optimization",
			"after-construction-generation-finalization",
			"before-memory-and-provenance",
			"before-program-flow",
			"after-cross-call-transforms",
			"before-sealing",
			"after-sealing",
		]);
		const finalCheckpoint = report.checkpoints.at(-1)!;
		expect({
			blocks: finalCheckpoint.blocks.live,
			instructions: finalCheckpoint.instructions.live,
			values: finalCheckpoint.values.live,
			uses: finalCheckpoint.uses.live,
			operands: finalCheckpoint.operands.live,
			blockParameters: finalCheckpoint.blockParameters.live,
			terminatorEdges: finalCheckpoint.terminatorEdges.live,
			terminatorArguments: finalCheckpoint.terminatorArguments,
			handlerArguments: finalCheckpoint.handlerArguments.live,
			facts: finalCheckpoint.facts.live,
			effectRefinements: finalCheckpoint.effectRefinements.live,
		}).toEqual(scanLiveStorage(compilation.program));

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
