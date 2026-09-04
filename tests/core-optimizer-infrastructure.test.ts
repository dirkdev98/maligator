import { describe, expect, it, vi } from "vitest";
import type { CoreAnalysisDefinition } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreAnalysisScratchPool } from "../src/compiler/core/core-analysis-scratch.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CORE_CONTROL_FLOW_PASSES } from "../src/compiler/core/core-control-flow-passes.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { CORE_FUNCTION_HAS_BACKEDGES } from "../src/compiler/core/core-function-features.ts";
import {
	CoreFunctionOptimizationResources,
	CoreFunctionOptimizationSession,
} from "../src/compiler/core/core-function-optimization-session.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "../src/compiler/core/core-ir-control-flow.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import {
	CORE_CONSTRUCTION_ANNOTATION_PASSES,
	CORE_CONSTRUCTION_NORMALIZATION_PASSES,
} from "../src/compiler/core/core-local-passes.ts";
import {
	CORE_MEMORY_PASSES,
	CORE_MEMORY_SSA_PASSES,
	CORE_PROVENANCE_PASSES,
} from "../src/compiler/core/core-memory-passes.ts";
import {
	CORE_O2_PASS_BUDGETS,
	CORE_OPTIMIZATION_FAMILIES,
	CORE_OPTIMIZATION_PROFITABILITY_CONTRACTS,
} from "../src/compiler/core/core-optimization-families.ts";
import { CORE_OPTIMIZATION_OWNER } from "../src/compiler/core/core-optimization-owners.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import type { CoreFunctionPass } from "../src/compiler/core/core-pass.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";
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

function noOpPass(name: string, runs: Array<number>): CoreFunctionPass {
	return {
		name,
		stage: "canonicalize",
		requiredAnalyses: [],
		wakesOn: ["body", "representations"],
		changes: { cfg: false, calls: false, facts: false, representations: false },
		budget: { maxWorkItems: 100, maxEdits: 100, exhaustion: "stop" },
		run({ item }) {
			runs[item.function] = (runs[item.function] ?? 0) + 1;
			return undefined;
		},
	};
}

describe("Core optimizer infrastructure", () => {
	it("charges nested owner scopes exclusively", () => {
		const { program } = programWithTwoFunctions();
		const allocatedBytes = vi
			.fn<() => number>()
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(110)
			.mockReturnValueOnce(120)
			.mockReturnValueOnce(150)
			.mockReturnValueOnce(200)
			.mockReturnValueOnce(210);
		const collections = vi
			.fn<() => number>()
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(1)
			.mockReturnValueOnce(2)
			.mockReturnValueOnce(3);
		Reflect.set(globalThis, "__mal_gc_allocated_bytes", allocatedBytes);
		Reflect.set(globalThis, "__mal_gc_collections", collections);
		const now = vi
			.spyOn(Date, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(1)
			.mockReturnValueOnce(2)
			.mockReturnValueOnce(5)
			.mockReturnValueOnce(10)
			.mockReturnValueOnce(11);
		try {
			const report = new CoreOptimizationReportBuilder(program, "full");
			report.measureOwner(CORE_OPTIMIZATION_OWNER.constructionStructuralCleanup, () =>
				report.measureOwner(CORE_OPTIMIZATION_OWNER.denseGenerationBarrier, () => {}),
			);
			const owners = report.finish(program, {
				directEntries: [],
				specializations: [],
			}).owners;

			expect(
				owners[CORE_OPTIMIZATION_OWNER.constructionStructuralCleanup]!.elapsedMs,
			).toBe(6);
			expect(owners[CORE_OPTIMIZATION_OWNER.denseGenerationBarrier]!.elapsedMs).toBe(3);
			expect(owners[CORE_OPTIMIZATION_OWNER.unattributed]!.elapsedMs).toBe(0);
			expect(owners[CORE_OPTIMIZATION_OWNER.optimizerOrchestration]!.elapsedMs).toBe(2);
			expect(owners[CORE_OPTIMIZATION_OWNER.constructionStructuralCleanup]).toMatchObject(
				{ allocatedBytes: 60, collections: 1 },
			);
			expect(owners[CORE_OPTIMIZATION_OWNER.denseGenerationBarrier]).toMatchObject({
				allocatedBytes: 30,
				collections: 1,
			});
			expect(owners[CORE_OPTIMIZATION_OWNER.optimizerOrchestration]).toMatchObject({
				allocatedBytes: 20,
				collections: 1,
			});
		} finally {
			now.mockRestore();
			Reflect.deleteProperty(globalThis, "__mal_gc_allocated_bytes");
			Reflect.deleteProperty(globalThis, "__mal_gc_collections");
		}
	});

	it("reuses bounded scratch without aliasing active leases", () => {
		const scratch = new CoreAnalysisScratchPool(64);
		const first = scratch.leaseInt32(4);
		const concurrent = scratch.leaseInt32(4);
		expect(concurrent.values).not.toBe(first.values);

		first.release();
		concurrent.release();
		const reused = scratch.leaseInt32(3);
		expect([first.values, concurrent.values]).toContain(reused.values);
		reused.release();

		const oversized = scratch.leaseInt32(32);
		oversized.release();
		expect(scratch.statistics()).toEqual({
			retainedBytes: 32,
			int32Buffers: 2,
			uint8Buffers: 0,
		});
		expect(() => reused.release()).toThrow("already released");
	});

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

	it("permits only structural control flow before the dense generation barrier", () => {
		expect(
			CORE_CONSTRUCTION_ANNOTATION_PASSES.flatMap(
				({ requiredAnalyses }) => requiredAnalyses,
			),
		).toEqual([]);
		for (const pass of CORE_CONSTRUCTION_NORMALIZATION_PASSES) {
			expect(pass.requiredAnalyses).toEqual([CORE_CONTROL_FLOW_BUNDLE_ANALYSIS]);
		}
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
		const manager = new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functions[0]!.id,
		);
		manager.runComponent("canonicalize", [noOpPass("local", runs)], [changes]);
		expect(runs).toEqual([1]);
	});

	it("scopes primary function work to one session target", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		const runs: Array<number> = [];
		new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functions[1]!.id,
		).runComponent("canonicalize", [noOpPass("session-local", runs)]);

		expect(runs[functions[0]!.id]).toBeUndefined();
		expect(runs[functions[1]!.id]).toBe(1);
		expect(
			report.finish(program, { directEntries: [], specializations: [] }).queue,
		).toEqual({ pushes: 1, pops: 1, maximumDepth: 1 });
	});

	it("opens at most one primary session for a function", () => {
		const { program, functions } = programWithTwoFunctions();
		const report = new CoreOptimizationReportBuilder(program);
		const resources = new CoreFunctionOptimizationResources(program);
		new CoreFunctionOptimizationSession(
			program,
			context(),
			report,
			resources,
			functions[0]!.id,
		);

		expect(
			() =>
				new CoreFunctionOptimizationSession(
					program,
					context(),
					report,
					resources,
					functions[0]!.id,
				),
		).toThrow("already has a primary session");
	});

	it("opens a changed caller at most once per cross-call wave", () => {
		const { program, functions } = programWithTwoFunctions();
		const report = new CoreOptimizationReportBuilder(program);
		const resources = new CoreFunctionOptimizationResources(program);
		const open = (wave: number) =>
			new CoreFunctionOptimizationSession(
				program,
				context(),
				report,
				resources,
				functions[0]!.id,
				{ crossCallWave: wave },
			);
		open(0);

		expect(() => open(0)).toThrow("already has a cross-call session in wave 0");
		expect(() => open(1)).not.toThrow();
	});

	it("does not reseed fused local work for an already-consumed change batch", () => {
		const { program, functions } = programWithTwoFunctions();
		const report = new CoreOptimizationReportBuilder(program, "full");
		const analyses = new CoreAnalysisManager(program, context(), report);
		const editor = CoreEditor.open(program, functions[0]!.id);
		editor.setValueRepresentation(functions[0]!.value, "f64");
		const changes = editor.commit();
		const runs: Array<number> = [];

		new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functions[0]!.id,
			{
				localOptimization: true,
			},
		).runComponent("canonicalize", [noOpPass("late", runs)], [changes], false);

		expect(runs).toEqual([1]);
		expect(
			report
				.finish(program, { directEntries: [], specializations: [] })
				.passes.map(({ pass }) => pass),
		).toEqual(["late"]);
	});

	it("does not rerun an existing pass when a no-op pass is registered", () => {
		const run = (withExtraPass: boolean): Array<number> => {
			const { program, functions } = programWithTwoFunctions();
			const report = new CoreOptimizationReportBuilder(program);
			const existingRuns: Array<number> = [];
			const passes = [noOpPass("existing", existingRuns)];
			if (withExtraPass) passes.push(noOpPass("extra", []));
			for (const { id } of functions) {
				const analyses = new CoreAnalysisManager(program, context(), report);
				new CoreFunctionPassScheduler(
					program,
					context(),
					analyses,
					report,
					id,
				).runComponent("canonicalize", passes);
			}
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
		const loopPass: CoreFunctionPass = {
			name: "test-loop-pass",
			stage: "control-flow",
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

		new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			loopFunction,
		).runComponent("control-flow", [loopPass]);

		expect(analyzed).toEqual([loopFunction]);
	});

	it("does not build memory versions for memory-free functions", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		const forwarding = CORE_MEMORY_PASSES.find(
			({ name }) => name === "forward-exact-memory-loads",
		)!;

		new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functions[0]!.id,
		).runComponent("memory", [forwarding]);

		expect(
			report
				.finish(program, { directEntries: [], specializations: [] })
				.analyses.find(({ analysis }) => analysis === "local-memory-versions"),
		).toBeUndefined();
	});

	it("does not build memory versions for repeated pure operations", () => {
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
			opcode: "store",
			inputs: coreArity(1),
			outputs: coreArity(0),
			effects: { ...CORE_NO_EFFECTS, writes: ["global-slot"] },
			discardable: false,
			attributeRelocations: [],
			accesses: [{ family: "global-slot", mode: "write", valueOperand: 0 }],
		});
		const program = new CoreProgram(registry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.appendInstruction(entry, "identity", [parameter]);
		const [value] = builder.appendInstruction(entry, "identity", [parameter]);
		builder.appendInstruction(entry, "store", [parameter]);
		builder.setTerminator(entry, { kind: "return", value: value! });
		const functionId = builder.finish(entry).function;
		const { analyses, report } = analysisHarness(program);
		const forwarding = CORE_MEMORY_PASSES.find(
			({ name }) => name === "forward-exact-memory-loads",
		)!;

		new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functionId,
		).runComponent("memory", [forwarding]);

		expect(
			report
				.finish(program, { directEntries: [], specializations: [] })
				.analyses.find(({ analysis }) => analysis === "local-memory-versions"),
		).toBeUndefined();
	});

	it("does not build fact availability without a proof-rewiring consumer", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		const rewiring = CORE_PROOF_PASSES.find(
			({ name }) => name === "rewire-subsumed-effect-proofs",
		)!;

		new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functions[0]!.id,
		).runComponent("proofs", [rewiring]);

		expect(
			report
				.finish(program, { directEntries: [], specializations: [] })
				.analyses.find(({ analysis }) => analysis === "fact-availability"),
		).toBeUndefined();
	});

	it("does not build control flow without incoming block arguments", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		const simplification = CORE_CONSTRUCTION_NORMALIZATION_PASSES.find(
			({ name }) => name === "block-parameter-simplification",
		)!;

		new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functions[0]!.id,
		).runComponent("canonicalize", [simplification]);

		expect(
			report
				.finish(program, { directEntries: [], specializations: [] })
				.analyses.find(({ analysis }) => analysis === "structural-control-flow"),
		).toBeUndefined();
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
			const pass: CoreFunctionPass = {
				name: "test-candidate-pass",
				stage: "canonicalize",
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
			const report = new CoreOptimizationReportBuilder(program);
			for (const functionId of program.functionIds()) {
				const analyses = new CoreAnalysisManager(program, context(), report);
				new CoreFunctionPassScheduler(
					program,
					context(),
					analyses,
					report,
					functionId,
				).runComponent("canonicalize", [pass]);
			}
			return analyzed;
		};

		expect(run(["identity"])).toEqual([0, 1]);
		expect(run(["rewritten-identity"])).toEqual([]);
	});

	it("makes ineligible admitted passes perform zero analysis queries", () => {
		const { program, functions } = programWithTwoFunctions();
		const queried: Array<number> = [];
		const analysis: CoreAnalysisDefinition<number> = {
			key: "test-admitted-analysis",
			scope: "function",
			functionDependencies: ["body"],
			compute({ request }) {
				if (request.scope !== "function") throw new Error("expected function scope");
				queried.push(request.function);
				return request.function;
			},
		};
		const pass: CoreFunctionPass = {
			name: "test-admitted-pass",
			stage: "canonicalize",
			admission: {
				predicate: "function id is odd",
				hasOpportunity: ({ function: functionId }) => functionId % 2 === 1,
			},
			requiredAnalyses: [analysis],
			wakesOn: ["body"],
			changes: { cfg: false, calls: false, facts: false, representations: false },
			budget: { maxWorkItems: 10, maxEdits: 1, exhaustion: "error" },
			run(passContext) {
				passContext.analysis(analysis);
				return undefined;
			},
		};
		const report = new CoreOptimizationReportBuilder(program);
		for (const { id } of functions) {
			const analyses = new CoreAnalysisManager(program, context(), report);
			new CoreFunctionPassScheduler(
				program,
				context(),
				analyses,
				report,
				id,
			).runComponent("canonicalize", [pass]);
		}

		expect(queried).toEqual([functions[1]!.id]);
		expect(
			report.finish(program, { directEntries: [], specializations: [] }).analyses,
		).toMatchObject([{ analysis: "test-admitted-analysis", queries: 1 }]);
	});

	it("declares concrete admissions for every analysis-backed O2 pass", () => {
		for (const pass of [
			...CORE_CONTROL_FLOW_PASSES,
			...CORE_PROOF_PASSES,
			...CORE_MEMORY_PASSES,
		]) {
			if (pass.requiredAnalyses.length === 0) continue;
			expect(pass.admission, pass.name).toBeDefined();
			expect(pass.admission?.predicate.trim().length, pass.name).toBeGreaterThan(0);
		}
	});

	it("binds every non-O1 family to its profitability contract", () => {
		expect(Object.keys(CORE_OPTIMIZATION_PROFITABILITY_CONTRACTS)).toEqual(
			CORE_OPTIMIZATION_FAMILIES.slice(1),
		);
		for (const contract of Object.values(CORE_OPTIMIZATION_PROFITABILITY_CONTRACTS)) {
			expect(Object.values(contract).every((value) => value.trim().length > 0)).toBe(
				true,
			);
		}
		for (const pass of CORE_CONTROL_FLOW_PASSES) {
			expect(pass.budget).toBe(CORE_O2_PASS_BUDGETS["cfg-loop-licm-pre"]);
		}
		for (const pass of CORE_PROOF_PASSES) {
			expect(pass.budget).toBe(CORE_O2_PASS_BUDGETS["proof-value-kind-representation"]);
		}
		for (const pass of CORE_PROVENANCE_PASSES) {
			expect(pass.budget).toBe(
				CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
			);
		}
		for (const pass of CORE_MEMORY_SSA_PASSES) {
			expect(pass.budget).toBe(CORE_O2_PASS_BUDGETS["memory-ssa-load-store"]);
		}
	});

	it("makes an O2-ineligible function perform zero analysis queries", () => {
		const { program, functions } = programWithTwoFunctions();
		const { analyses, report } = analysisHarness(program);
		const scheduler = new CoreFunctionPassScheduler(
			program,
			context(),
			analyses,
			report,
			functions[0]!.id,
		);

		scheduler.runComponent("control-flow", CORE_CONTROL_FLOW_PASSES);
		scheduler.runComponent("proofs", CORE_PROOF_PASSES);
		scheduler.runComponent("memory", CORE_MEMORY_PASSES);

		expect(
			report.finish(program, { directEntries: [], specializations: [] }).analyses,
		).toEqual([]);
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
			const pass: CoreFunctionPass = {
				name: "bounded-rewrite",
				stage: "canonicalize",
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
					if (item.function !== target.id) return undefined;
					remaining.push(remainingEdits);
					runs++;
					if (runs > 2) return undefined;
					const editor = CoreEditor.open(program, target.id);
					editor.setValueRepresentation(target.value, runs === 1 ? "f64" : "i32");
					return editor.commit();
				},
			};
			const { analyses, report } = analysisHarness(program);
			new CoreFunctionPassScheduler(program, context(), analyses, report, target.id, {
				...(optionalMaxRunsPerWorkItem === undefined
					? {}
					: { optionalMaxRunsPerWorkItem }),
			}).runComponent("canonicalize", [pass]);
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
		const { program, functions } = programWithTwoFunctions();
		const report = new CoreOptimizationReportBuilder(program);
		for (const { id } of functions) {
			const analyses = new CoreAnalysisManager(program, context(), report);
			new CoreFunctionPassScheduler(
				program,
				context(),
				analyses,
				report,
				id,
			).runComponent("canonicalize", [noOpPass("reported", [])]);
		}
		const finished = report.finish(program, { directEntries: [], specializations: [] });
		expect(finished.queue).toEqual({ pushes: 2, pops: 2, maximumDepth: 1 });
		expect(finished.budget).toMatchObject({ workItems: 2, edits: 0 });
		expect(Object.keys(finished)).not.toContain("rounds");
	});

	it("reports the active worklist stage when per-pass verification fails", () => {
		const { program, functions } = programWithTwoFunctions();
		const target = functions[0]!;
		let edited = false;
		const invalid: CoreFunctionPass = {
			name: "invalid-rewrite",
			stage: "control-flow",
			requiredAnalyses: [],
			wakesOn: ["cfg"],
			changes: { cfg: true, calls: false, facts: false, representations: false },
			budget: { maxWorkItems: 10, maxEdits: 10, exhaustion: "error" },
			run({ item }) {
				if (edited || item.function !== target.id) {
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
			new CoreFunctionPassScheduler(program, context(), analyses, report, target.id, {
				verification: "per-pass",
			}).runComponent("control-flow", [invalid]),
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
