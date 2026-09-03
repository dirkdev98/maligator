import { describe, expect, it } from "vitest";
import type { CoreAnalysisDefinition } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CORE_FUNCTION_HAS_BACKEDGES } from "../src/compiler/core/core-function-features.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CorePassManager } from "../src/compiler/core/core-pass-manager.ts";
import type { CorePass } from "../src/compiler/core/core-pass.ts";
import {
	CORE_PROGRAM_FLOW_REPRESENTATIONS,
	CoreProgram,
} from "../src/compiler/core/core-store.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";

function context(): CoreCompilationContext {
	return {
		facts: conservativeCompilerProgramFacts(),
		data: {
			entrypointPath: "optimizer-infrastructure.js",
			moduleEvaluationOrder: ["optimizer-infrastructure.js"],
			sourceFiles: [{ path: "optimizer-infrastructure.js", contents: "" }],
			cjsModuleFunctionIndices: [],
			hostInstallCandidates: [],
			singleAssignmentGlobalSlots: [],
			singleAssignmentCapturedSlots: [],
			retainedHostInstallers: [],
		},
	};
}

function programWithTwoFunctions() {
	const registry = new CoreOpcodeRegistry();
	registry.define({
		opcode: "identity",
		inputs: coreArity(1),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
		attributeRelocations: [],
	});
	registry.define({
		opcode: "rewritten-identity",
		inputs: coreArity(1),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
		attributeRelocations: [],
	});
	const program = new CoreProgram(registry);
	const functions = Array.from({ length: 2 }, () => {
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [value] = builder.appendInstruction(entry, "identity", [parameter], {
			outputRepresentations: ["i32"],
		});
		builder.setTerminator(entry, { kind: "return", value: value! });
		const finished = builder.finish(entry);
		return { id: finished.function, entry, value: value! };
	});
	return { program, functions };
}

function analysisHarness(program: CoreProgram) {
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context(), report);
	return { analyses, report };
}

const cfgAnalysis = (recomputations: Array<number>): CoreAnalysisDefinition<number> => ({
	key: "test-cfg",
	scope: "function",
	functionDependencies: ["cfg"],
	compute({ program, request }) {
		if (request.scope !== "function") throw new Error("expected function scope");
		recomputations[request.function] = (recomputations[request.function] ?? 0) + 1;
		return [...program.function(request.function).blockIds()].length;
	},
});

function noOpPass(name: string, runs: Array<number>): CorePass {
	return {
		name,
		stage: "canonicalize",
		scope: "function",
		requiredAnalyses: [],
		wakesOn: ["body", "representations"],
		changes: { cfg: false, calls: false, facts: false, representations: false },
		budget: { maxWorkItems: 100, maxEdits: 100, exhaustion: "stop" },
		run({ item }) {
			if (item.scope !== "function") throw new Error("expected function work item");
			runs[item.function] = (runs[item.function] ?? 0) + 1;
			return undefined;
		},
	};
}

describe("Core optimizer infrastructure", () => {
	it("journals function edits as compact program-flow changes", () => {
		const { program, functions } = programWithTwoFunctions();
		const revision = program.programFlowRevision;
		const editor = CoreEditor.open(program, functions[0]!.id);
		editor.setValueRepresentation(functions[0]!.value, "f64");
		editor.commit();

		expect(program.programFlowRevision).toBe(revision + 1);
		expect(program.programFlowFunctionAt(revision)).toBe(functions[0]!.id);
		expect(
			program.programFlowDomainMaskAt(revision) & CORE_PROGRAM_FLOW_REPRESENTATIONS,
		).toBe(CORE_PROGRAM_FLOW_REPRESENTATIONS);

		CoreEditor.open(program, functions[1]!.id).commit();
		expect(program.programFlowRevision).toBe(revision + 1);
	});

	it("keys function analysis reuse to exact dependency versions", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		const recomputations: Array<number> = [];
		const analysis = cfgAnalysis(recomputations);

		expect(
			analyses.get(analysis, { scope: "function", function: functions[0]!.id }),
		).toBe(1);
		analyses.get(analysis, { scope: "function", function: functions[1]!.id });
		const representationEditor = CoreEditor.open(program, functions[0]!.id);
		representationEditor.setValueRepresentation(functions[0]!.value, "f64");
		representationEditor.commit();
		analyses.get(analysis, { scope: "function", function: functions[0]!.id });
		expect(recomputations).toEqual([1, 1]);

		const cfgEditor = CoreEditor.open(program, functions[0]!.id);
		const addedBlock = cfgEditor.createBlock();
		cfgEditor.setTerminator(addedBlock, {
			kind: "return",
			value: functions[0]!.value,
		});
		cfgEditor.commit();
		analyses.get(analysis, { scope: "function", function: functions[0]!.id });
		analyses.get(analysis, { scope: "function", function: functions[1]!.id });
		expect(recomputations).toEqual([2, 1]);
		const finished = report.finish(program, { directEntries: [], specializations: [] });
		expect(finished.analyses).toMatchObject([
			{ queries: 5, hits: 2, recomputations: 3, invalidations: 1 },
		]);
	});

	it("rejects every analysis manager from the construction generation", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses } = analysisHarness(program);
		const analysis = cfgAnalysis([]);
		expect(
			analyses.get(analysis, { scope: "function", function: functions[0]!.id }),
		).toBe(1);

		program.finalizeConstructionGeneration();

		expect(() =>
			analyses.get(analysis, { scope: "function", function: functions[0]!.id }),
		).toThrow("analysis manager belongs to retired generation 0");
	});

	it("checks program analysis function dependencies without scanning functions", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses } = analysisHarness(program);
		let recomputations = 0;
		const analysis: CoreAnalysisDefinition<number> = {
			key: "test-program-body",
			scope: "program",
			functionDependencies: ["body"],
			programDependencies: ["functions"],
			compute() {
				return ++recomputations;
			},
		};

		expect(analyses.get(analysis, { scope: "program" })).toBe(1);
		expect(analyses.get(analysis, { scope: "program" })).toBe(1);
		Object.defineProperty(program.function(functions[1]!.id), "version", {
			value() {
				throw new Error("stable function was scanned");
			},
		});
		const representationEditor = CoreEditor.open(program, functions[0]!.id);
		representationEditor.setValueRepresentation(functions[0]!.value, "f64");
		representationEditor.commit();
		expect(analyses.get(analysis, { scope: "program" })).toBe(1);

		const bodyEditor = CoreEditor.open(program, functions[0]!.id);
		bodyEditor.configureFunction({ isAsync: true });
		bodyEditor.commit();
		expect(analyses.get(analysis, { scope: "program" })).toBe(2);
	});

	it("runs an incremental local pass only for the edited function", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		const editor = CoreEditor.open(program, functions[0]!.id);
		editor.setValueRepresentation(functions[0]!.value, "f64");
		const changes = editor.commit();
		const runs: Array<number> = [];
		const manager = new CorePassManager(program, context(), analyses, report);
		manager.runStage("canonicalize", [noOpPass("local", runs)], [changes]);
		expect(runs).toEqual([1]);
	});

	it("does not reseed fused local work for an already-consumed change batch", () => {
		const { program, functions } = programWithTwoFunctions();
		const report = new CoreOptimizationReportBuilder(program, "full");
		const analyses = new CoreAnalysisManager(program, context(), report);
		const editor = CoreEditor.open(program, functions[0]!.id);
		editor.setValueRepresentation(functions[0]!.value, "f64");
		const changes = editor.commit();
		const runs: Array<number> = [];

		new CorePassManager(program, context(), analyses, report, {
			localOptimization: true,
		}).runStage("canonicalize", [noOpPass("late", runs)], [changes], "finalize", false);

		expect(runs).toEqual([1]);
		expect(
			report
				.finish(program, { directEntries: [], specializations: [] })
				.passes.map(({ pass }) => pass),
		).toEqual(["late"]);
	});

	it("does not rerun an existing pass when a no-op pass is registered", () => {
		const run = (withExtraPass: boolean): Array<number> => {
			const { program } = programWithTwoFunctions();
			const { analyses, report } = analysisHarness(program);
			const existingRuns: Array<number> = [];
			const passes = [noOpPass("existing", existingRuns)];
			if (withExtraPass) passes.push(noOpPass("extra", []));
			new CorePassManager(program, context(), analyses, report).runStage(
				"canonicalize",
				passes,
			);
			return existingRuns;
		};
		expect(run(false)).toEqual([1, 1]);
		expect(run(true)).toEqual([1, 1]);
	});

	it("does not request loop analyses for loop-free functions", () => {
		const { program } = programWithTwoFunctions();
		const loop = new CoreFunctionBuilder(program);
		const header = loop.createBlock();
		loop.setTerminator(header, {
			kind: "jump",
			edge: { block: header, arguments: [] },
		});
		const loopFunction = loop.finish(header).function;
		const analyzed: Array<number> = [];
		const loopAnalysis: CoreAnalysisDefinition<number> = {
			key: "test-loop-analysis",
			scope: "function",
			functionDependencies: ["cfg"],
			compute({ request }) {
				if (request.scope !== "function") throw new Error("expected function scope");
				analyzed.push(request.function);
				return request.function;
			},
		};
		const loopPass: CorePass = {
			name: "test-loop-pass",
			stage: "control-flow",
			scope: "function",
			requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
			requiredAnalyses: [loopAnalysis],
			wakesOn: ["cfg"],
			changes: { cfg: false, calls: false, facts: false, representations: false },
			budget: { maxWorkItems: 10, maxEdits: 1, exhaustion: "error" },
			run(passContext) {
				passContext.analysis(loopAnalysis);
				return undefined;
			},
		};
		const { analyses, report } = analysisHarness(program);

		new CorePassManager(program, context(), analyses, report).runStage("control-flow", [
			loopPass,
		]);

		expect(analyzed).toEqual([loopFunction]);
	});

	it("skips function passes without a matching candidate opcode", () => {
		const run = (requiredFunctionOpcodesAny: ReadonlyArray<string>) => {
			const { program } = programWithTwoFunctions();
			const analyzed: Array<number> = [];
			const candidateAnalysis: CoreAnalysisDefinition<number> = {
				key: "test-candidate-analysis",
				scope: "function",
				functionDependencies: ["body"],
				compute({ request }) {
					if (request.scope !== "function") throw new Error("expected function scope");
					analyzed.push(request.function);
					return request.function;
				},
			};
			const pass: CorePass = {
				name: "test-candidate-pass",
				stage: "canonicalize",
				scope: "function",
				requiredFunctionOpcodesAny,
				requiredAnalyses: [candidateAnalysis],
				wakesOn: ["body"],
				changes: { cfg: false, calls: false, facts: false, representations: false },
				budget: { maxWorkItems: 10, maxEdits: 1, exhaustion: "error" },
				run(passContext) {
					passContext.analysis(candidateAnalysis);
					return undefined;
				},
			};
			const { analyses, report } = analysisHarness(program);
			new CorePassManager(program, context(), analyses, report).runStage("canonicalize", [
				pass,
			]);
			return analyzed;
		};

		expect(run(["identity"])).toEqual([0, 1]);
		expect(run(["rewritten-identity"])).toEqual([]);
	});

	it("bounds only optional development work and reports profile exhaustion", () => {
		const run = (
			optionalMaxRunsPerWorkItem: number | undefined,
			exhaustion: "stop" | "error",
		) => {
			const { program, functions } = programWithTwoFunctions();
			const target = functions[0]!;
			let runs = 0;
			const remaining: Array<number> = [];
			const pass: CorePass = {
				name: "bounded-rewrite",
				stage: "canonicalize",
				scope: "function",
				requiredAnalyses: [],
				wakesOn: ["representations"],
				changes: {
					cfg: false,
					calls: false,
					facts: false,
					representations: true,
				},
				budget: { maxWorkItems: 10, maxEdits: 10, exhaustion },
				run({ item, remainingEdits }) {
					if (item.scope !== "function" || item.function !== target.id) return undefined;
					remaining.push(remainingEdits);
					runs++;
					if (runs > 2) return undefined;
					const editor = CoreEditor.open(program, target.id);
					editor.setValueRepresentation(target.value, runs === 1 ? "f64" : "i32");
					return editor.commit();
				},
			};
			const { analyses, report } = analysisHarness(program);
			new CorePassManager(program, context(), analyses, report, {
				...(optionalMaxRunsPerWorkItem === undefined
					? {}
					: { optionalMaxRunsPerWorkItem }),
			}).runStage("canonicalize", [pass]);
			return {
				runs,
				representation: program.function(target.id).valueRepresentation(target.value),
				remaining,
				exhausted: report.finish(program, {
					directEntries: [],
					specializations: [],
				}).budget.exhaustedPasses,
			};
		};

		expect(run(1, "stop")).toEqual({
			runs: 1,
			representation: "f64",
			remaining: [10],
			exhausted: ["bounded-rewrite"],
		});
		expect(run(1, "error")).toEqual({
			runs: 3,
			representation: "i32",
			remaining: [10, 9, 8],
			exhausted: [],
		});
	});

	it("requires whole-program analyses to name a program dependency", () => {
		const { program } = programWithTwoFunctions();
		const { analyses } = analysisHarness(program);
		expect(() =>
			analyses.get(
				{
					key: "invalid-program-analysis",
					scope: "program",
					compute: () => 0,
				},
				{ scope: "program" },
			),
		).toThrow("explicit program dependency");
	});

	it("validates reused analysis definitions without masking scope or key conflicts", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses } = analysisHarness(program);
		const analysis = cfgAnalysis([]);
		const functionRequest = { scope: "function" as const, function: functions[0]!.id };
		analyses.get(analysis, functionRequest);
		analyses.get(analysis, functionRequest);
		expect(() => analyses.get(analysis, { scope: "program" })).toThrow(
			"requires function scope",
		);
		expect(() =>
			analyses.get({ ...analysis, functionDependencies: ["body"] }, functionRequest),
		).toThrow("conflicting dependencies");
	});

	it("reports queue and budget work without a global round counter", () => {
		const { program } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		new CorePassManager(program, context(), analyses, report).runStage("canonicalize", [
			noOpPass("reported", []),
		]);
		const finished = report.finish(program, { directEntries: [], specializations: [] });
		expect(finished.queue).toEqual({ pushes: 2, pops: 2, maximumDepth: 2 });
		expect(finished.budget).toMatchObject({ workItems: 2, edits: 0 });
		expect(Object.keys(finished)).not.toContain("rounds");
	});

	it("reports the active worklist stage when per-pass verification fails", () => {
		const { program, functions } = programWithTwoFunctions();
		const target = functions[0]!;
		let edited = false;
		const invalid: CorePass = {
			name: "invalid-rewrite",
			stage: "control-flow",
			scope: "function",
			requiredAnalyses: [],
			wakesOn: ["cfg"],
			changes: { cfg: true, calls: false, facts: false, representations: false },
			budget: { maxWorkItems: 10, maxEdits: 10, exhaustion: "error" },
			run({ item }) {
				if (edited || item.scope !== "function" || item.function !== target.id) {
					return undefined;
				}
				edited = true;
				const editor = CoreEditor.open(program, target.id);
				const destination = editor.createBlock([{ representation: "boxed" }]);
				const parameter = inspectCoreBlockParameters(
					program.function(target.id),
					destination,
				)[0]!;
				editor.removeInstruction(
					program.function(target.id).blockTerminator(target.entry),
				);
				editor.setTerminator(target.entry, {
					kind: "jump",
					edge: { block: destination, arguments: [] },
				});
				editor.setTerminator(destination, {
					kind: "return",
					value: parameter.value,
				});
				return editor.commit();
			},
		};
		const { analyses, report } = analysisHarness(program);

		expect(() =>
			new CorePassManager(program, context(), analyses, report, {
				verification: "per-pass",
			}).runStage("control-flow", [invalid]),
		).toThrow(
			/Core IR verification failed \[stage=control-flow pass=invalid-rewrite function=0\]/,
		);
	});

	it("counts every discovery kind in the optimizer report", () => {
		const { program } = programWithTwoFunctions();
		const report = new CoreOptimizationReportBuilder(program);
		report.recordCandidateDiscovery([
			{ kind: "stack-object", fanOut: 1 },
			{ kind: "string-split-projection", fanOut: 3 },
		]);
		const discovery = report.finish(program, {
			directEntries: [],
			specializations: [],
		}).discovery;
		expect(discovery).toMatchObject({
			candidates: 2,
			byKind: { "stack-object": 1, "string-split-projection": 1 },
			largestFanOut: 3,
		});
	});
});
