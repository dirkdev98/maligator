import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { runCoreCrossCallTransforms } from "../src/compiler/core/core-cross-call-transforms.ts";
import type { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import {
	CoreFunctionOptimizationResources,
	CoreFunctionOptimizationSession,
} from "../src/compiler/core/core-function-optimization-session.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import type { CorePgoHints } from "../src/compiler/core/core-pgo.ts";
import {
	CORE_PROGRAM_SUMMARIES_ANALYSIS,
	CORE_PROGRAM_VALUE_KIND_ANALYSIS,
} from "../src/compiler/core/core-program-flow-analysis.ts";
import { projectCoreSpecializationRecipes } from "../src/compiler/core/core-specialization-recipes.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	coreProgramTransformBudgets,
	CoreTransformCandidateService,
} from "../src/compiler/core/core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
} from "../src/compiler/core/core-transform-candidates.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreTerminatorPayload,
} from "./helpers/core-inspection.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";
import {
	analysisProgram,
	appendCaller,
	appendLeaf,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

function runTransforms(
	program: CoreProgram,
	limits?: CoreTransformBudgetLimits,
	pgo?: CorePgoHints,
	beforeOptimizeCaller?: (
		wave: number,
		functionId: CoreFunctionId,
		editor: CoreEditor,
	) => void,
) {
	const context = programAnalysisContext();
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	const resources = new CoreFunctionOptimizationResources(program);
	const candidates = new CoreTransformCandidateService(limits);
	const result = runCoreCrossCallTransforms(
		program,
		analyses,
		(wave, functionId, editor) => {
			beforeOptimizeCaller?.(wave, functionId, editor);
			return new CoreFunctionOptimizationSession(
				program,
				context,
				report,
				resources,
				functionId,
				{ crossCallWave: wave },
			).optimizeCrossCall(editor);
		},
		limits,
		undefined,
		candidates,
		pgo,
	);
	return {
		...result,
		analyses,
		report,
		plan: buildCoreOptimizationPlan(
			program,
			analyses,
			result.summaries,
			[...program.functionIds()],
			{ candidateService: candidates },
		),
	};
}

function callInstructions(program: CoreProgram, functionId: number) {
	const fn = program.function(functionId as never);
	return [...fn.instructionIds()].filter(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer !== undefined,
	);
}

function appendBudgetCaller(
	program: CoreProgram,
	target: number,
	loop: boolean,
	guarded = false,
) {
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{}]);
	const body = loop ? builder.createBlock() : entry;
	const exit = loop ? builder.createBlock() : body;
	const condition = builder.blockParameterValue(entry, 0);
	const [created] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: target },
	});
	let callee = created!;
	if (guarded) {
		const stringIndex = builder.editor.appendStringConstants([
			[..."method"].map((unit) => unit.charCodeAt(0)),
		]);
		const object = callee;
		builder.appendInstruction(entry, "storePropertyStatic", [object, callee], {
			attributes: { stringIndex },
			outputCount: 0,
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object], {
			attributes: { stringIndex },
		});
		callee = loaded!;
	}
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	if (loop)
		builder.setTerminator(entry, { kind: "jump", edge: { block: body, arguments: [] } });
	const [result] = builder.appendInstruction(body, "call", [
		callee,
		receiver!,
		condition,
	]);
	const call = builder.bodyInstructionIds(body).at(-1)!;
	if (loop) {
		builder.setTerminator(body, {
			kind: "branch",
			condition,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
	}
	builder.setTerminator(exit, { kind: "return", value: result! });
	return { function: builder.finish(entry).function, call };
}

const TINY_CODE_BUDGET: CoreTransformBudgetLimits = {
	perSiteExpansions: 1,
	perCallerExpansions: 8,
	perCallerGeneratedCode: 0,
	perCallerCompilerWork: 1_000,
	programGeneratedCode: 0,
	programCompilerWork: 10_000,
};

describe("bounded Core cross-call transforms", () => {
	it.each([
		{ code: 10, work: 0, reason: "generated-code-cost" },
		{ code: 0, work: 10, reason: "compiler-work-cost" },
	])(
		"scales program $reason allowance without relaxing caller limits",
		({ code, work, reason }) => {
			const limits: CoreTransformBudgetLimits = {
				perSiteExpansions: 1,
				perCallerExpansions: 4,
				perCallerGeneratedCode: 10,
				perCallerCompilerWork: 10,
				programGeneratedCode: 100,
				programCompilerWork: 100,
			};
			const small = new CoreTransformCandidateService(
				coreProgramTransformBudgets(limits, 100),
			);
			const large = new CoreTransformCandidateService(
				coreProgramTransformBudgets(limits, 65_536),
			);
			const candidate = (caller: number, site = 0): CoreTransformCandidate => ({
				kind: "inline",
				caller: caller as CoreTransformCandidate["caller"],
				site: site as CoreTransformCandidate["site"],
				revision: 0,
				priorityClass: 0,
				priorityScore: 0,
				targets: [],
				generatedCodeCost: code,
				compilerWorkCost: work,
				expansive: true,
			});
			for (let caller = 0; caller < 10; caller++) {
				for (const service of [small, large]) {
					expect(service.admit(candidate(caller))).toBeUndefined();
					service.recordApplied(candidate(caller));
				}
			}
			expect(small.admit(candidate(10))).toBe(reason);
			expect(large.admit(candidate(0))).toBe("expansion-limit");
			expect(large.admit(candidate(0, 1))).toBe(reason);
			for (let caller = 10; caller < 20; caller++) {
				expect(large.admit(candidate(caller))).toBeUndefined();
				large.recordApplied(candidate(caller));
			}
			expect(large.admit(candidate(20))).toBe(reason);
		},
	);

	it("retains attempted discovery work across phases without consuming code budget", () => {
		const service = new CoreTransformCandidateService({
			perSiteExpansions: 1,
			perCallerExpansions: 4,
			perCallerGeneratedCode: 20,
			perCallerCompilerWork: 5,
			programGeneratedCode: 20,
			programCompilerWork: 8,
		});
		const cost = {
			caller: 0 as CoreTransformCandidate["caller"],
			generatedCodeCost: 8,
			compilerWorkCost: 4,
		};
		expect(service.admitDiscovery(cost)).toBeUndefined();
		service.recordDiscovery(cost);
		service.beginPhase();
		expect(service.admitDiscovery(cost)).toBe("compiler-work-cost");
		const other = { ...cost, caller: 1 as CoreTransformCandidate["caller"] };
		expect(service.admitDiscovery(other)).toBeUndefined();
		service.recordDiscovery(other);
		expect(service.programBudgetExhaustionReason()).toBe("compiler-work-cost");
		expect(service.statistics().generatedCodeConsumed).toBe(0);
		expect(service.statistics().compilerWorkConsumed).toBe(8);
	});
	it("owns exactly two deliberate waves without driving pass stages", () => {
		const source = readFileSync(
			new URL("../src/compiler/core/core-cross-call-transforms.ts", import.meta.url),
			"utf8",
		);

		expect(source).toMatch(/wave < 2/);
		expect(source).not.toMatch(/while\s*\(true\)/);
		expect(source).not.toMatch(/passes\.runStage/);
		expect(source).not.toMatch(/finishCrossCallWave/);
	});

	it("deduplicates candidates and enforces site, caller, and compiler-work limits", () => {
		const service = new CoreTransformCandidateService({
			perSiteExpansions: 1,
			perCallerExpansions: 1,
			perCallerGeneratedCode: 10,
			perCallerCompilerWork: 3,
			programGeneratedCode: 10,
			programCompilerWork: 3,
		});
		const candidate = (
			priorityScore: number,
			site: number,
			work = 1,
		): CoreTransformCandidate => ({
			kind: "inline",
			caller: 0 as never,
			site: site as never,
			revision: 0,
			priorityClass: 0,
			priorityScore,
			targets: [1 as never],
			generatedCodeCost: 1,
			compilerWorkCost: work,
			expansive: true,
		});
		expect(service.offer(candidate(1, 1))).toBe(true);
		expect(service.offer(candidate(1, 1))).toBe(false);
		const first = service.next()!;
		expect(service.admit(first)).toBeUndefined();
		service.recordApplied(first);
		expect(service.admit(candidate(2, 1))).toBe("expansion-limit");
		expect(service.admit(candidate(2, 2))).toBe("expansion-limit");

		const compilerLimited = new CoreTransformCandidateService({
			perSiteExpansions: 2,
			perCallerExpansions: 2,
			perCallerGeneratedCode: 10,
			perCallerCompilerWork: 1,
			programGeneratedCode: 10,
			programCompilerWork: 1,
		});
		expect(compilerLimited.admit(candidate(1, 1, 2))).toBe("compiler-work-cost");

		const ordered = new CoreTransformCandidateService();
		for (const priority of [3, 1, 2]) ordered.offer(candidate(priority, priority));
		expect(ordered.next()?.priorityScore).toBe(1);
		ordered.offer(candidate(0, 4));
		expect([
			ordered.next()?.priorityScore,
			ordered.next()?.priorityScore,
			ordered.next()?.priorityScore,
		]).toEqual([0, 2, 3]);
	});

	it("discovers inline candidates without mutating analysis metadata into Core", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendLeaf(program);
		const result = runTransforms(program);
		expect(callInstructions(program, 0)).toEqual([]);
		expect(result.statistics.appliedByKind).toMatchObject({
			inline: 1,
		});
		expect(result.statistics.instructionsIntroduced).toBe(1);
		expect(result.statistics.generatedCodeConsumed).toBe(1);
		expect(result.statistics.callGraphFunctionsAnalyzed).toBeGreaterThan(2);
		expect(result.statistics.waves).toBeLessThanOrEqual(2);
		expect(result.statistics.programFlowResolves).toBe(result.statistics.waves + 1);
		expect(result.statistics.callerEditSessions).toBe(
			result.statistics.callerLocalOptimizations,
		);
	});

	it("spends a tight caller budget on the loop call before an earlier cold call", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		const loop = builder.createBlock();
		const exit = builder.createBlock();
		const condition = builder.blockParameterValue(entry, 0);
		const [callee] = builder.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "call", [callee!, receiver!]);
		const coldCall = builder.bodyInstructionIds(entry).at(-1)!;
		builder.setTerminator(entry, { kind: "jump", edge: { block: loop, arguments: [] } });
		const [result] = builder.appendInstruction(loop, "call", [callee!, receiver!]);
		builder.setTerminator(loop, {
			kind: "branch",
			condition,
			consequent: { block: loop, arguments: [] },
			alternate: { block: exit, arguments: [] },
		});
		builder.setTerminator(exit, { kind: "return", value: result! });
		const caller = builder.finish(entry).function;
		appendLeaf(program);

		const transformed = runTransforms(program, {
			...TINY_CODE_BUDGET,
			perCallerGeneratedCode: 1,
			programGeneratedCode: 1,
		});
		expect(callInstructions(program, caller)).toEqual([coldCall]);
		expect(transformed.statistics.generatedCodeConsumed).toBe(1);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it.each([false, true])(
		"selects the hot caller with reversed function order %s",
		(reverse) => {
			const program = analysisProgram();
			const first = appendBudgetCaller(program, 2, reverse);
			const second = appendBudgetCaller(program, 2, !reverse);
			appendLeaf(program);
			const hot = reverse ? first : second;
			const cold = reverse ? second : first;

			runTransforms(program, {
				...TINY_CODE_BUDGET,
				perCallerGeneratedCode: 1,
				programGeneratedCode: 1,
			});
			expect(callInstructions(program, hot.function)).toEqual([]);
			expect(callInstructions(program, cold.function)).toEqual([cold.call]);
			verifyCoreProgram(program, { stage: "pre-target" });
		},
	);

	it("selects measured exposure over a static loop under a one-inline budget", () => {
		const program = analysisProgram();
		const loop = appendBudgetCaller(program, 2, true);
		const hot = appendBudgetCaller(program, 2, false);
		appendLeaf(program);
		runTransforms(
			program,
			{ ...TINY_CODE_BUDGET, perCallerGeneratedCode: 1, programGeneratedCode: 1 },
			{
				digest: "fixture",
				functionEntries: () => undefined,
				callAttempts: (id) => (id === hot.function ? 2 : 1),
			},
		);
		expect(callInstructions(program, hot.function)).toEqual([]);
		expect(callInstructions(program, loop.function)).toEqual([loop.call]);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("keeps measured counts separate from unknown static loop weights", () => {
		const program = analysisProgram();
		const unknown = appendBudgetCaller(program, 2, true);
		const hot = appendBudgetCaller(program, 2, false);
		appendLeaf(program);
		runTransforms(
			program,
			{ ...TINY_CODE_BUDGET, perCallerGeneratedCode: 1, programGeneratedCode: 1 },
			{
				digest: "fixture",
				functionEntries: () => undefined,
				callAttempts: (id) => (id === hot.function ? 1 : undefined),
			},
		);
		expect(callInstructions(program, hot.function)).toEqual([]);
		expect(callInstructions(program, unknown.function)).toEqual([unknown.call]);
	});

	it("prefers a smaller inline over an earlier larger body at the same frequency", () => {
		const program = analysisProgram();
		const largeCaller = appendBudgetCaller(program, 2, false);
		const smallCaller = appendBudgetCaller(program, 3, false);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{}]);
		let value = builder.blockParameterValue(entry, 0);
		for (let index = 0; index < 3; index++) {
			const [negated] = builder.appendInstruction(entry, "unary", [value], {
				attributes: { operator: "!" },
			});
			value = negated!;
		}
		builder.setTerminator(entry, { kind: "return", value });
		builder.finish(entry);
		appendLeaf(program);

		const transformed = runTransforms(program, {
			...TINY_CODE_BUDGET,
			perCallerGeneratedCode: 3,
			programGeneratedCode: 3,
		});
		expect(callInstructions(program, largeCaller.function)).toEqual([largeCaller.call]);
		expect(callInstructions(program, smallCaller.function)).toEqual([]);
		expect(transformed.statistics.generatedCodeConsumed).toBe(1);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("lets an exact inline beat an earlier guarded call under the shared budget", () => {
		const program = analysisProgram();
		const guarded = appendBudgetCaller(program, 2, false, true);
		const exact = appendBudgetCaller(program, 2, false);
		appendLeaf(program);

		const transformed = runTransforms(program, {
			...TINY_CODE_BUDGET,
			perCallerGeneratedCode: 2,
			programGeneratedCode: 2,
		});
		expect(callInstructions(program, exact.function)).toEqual([]);
		expect(callInstructions(program, guarded.function)).toEqual([guarded.call]);
		expect(
			transformed.statistics.declinedByReason["generated-code-cost"],
		).toBeGreaterThan(0);
		expect(transformed.statistics.appliedByKind["guarded-inline"] ?? 0).toBe(0);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("does not spend measured inline budget on positive guarded call attempts", () => {
		const program = analysisProgram();
		const guarded = appendBudgetCaller(program, 2, false, true);
		const exact = appendBudgetCaller(program, 2, false);
		appendLeaf(program);

		const transformed = runTransforms(
			program,
			{
				...TINY_CODE_BUDGET,
				perCallerGeneratedCode: 2,
				programGeneratedCode: 2,
			},
			{
				digest: "guarded-call-attempts",
				functionEntries: () => undefined,
				callAttempts: (caller) => (caller === guarded.function ? 1_000 : 1),
			},
		);
		expect(callInstructions(program, exact.function)).toEqual([]);
		expect(callInstructions(program, guarded.function)).toEqual([guarded.call]);
		expect(transformed.statistics.appliedByKind.inline).toBe(1);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("keeps an open guarded region behind a measured closed call", () => {
		const program = analysisProgram();
		const open = appendBudgetCaller(program, 2, false, true);
		const closed = appendBudgetCaller(program, 2, false);
		appendLeaf(program);
		const context = programAnalysisContext();
		const analyses = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		expect(summaries.targets.site(open.function, open.call)?.open).toBe(true);
		expect(summaries.targets.site(closed.function, closed.call)?.open).toBe(false);
		const plan = buildCoreOptimizationPlan(
			program,
			analyses,
			summaries,
			[...program.functionIds()],
			{
				context,
				pgo: {
					digest: "guarded-region-attempts",
					functionEntries: () => 0,
					callAttempts: (caller) => (caller === open.function ? 1_000 : 1),
				},
				budgets: {
					perSiteExpansions: 1,
					perCallerExpansions: 4,
					perCallerGeneratedCode: 4,
					perCallerCompilerWork: 100,
					programGeneratedCode: 1,
					programCompilerWork: 100,
				},
			},
		);
		expect(
			projectCoreSpecializationRecipes(plan.recipes).filter(
				(recipe) => recipe.kind === "guarded-direct-call",
			),
		).toEqual([
			expect.objectContaining({ function: closed.function, anchors: [closed.call] }),
		]);
		verifyCoreOptimizationPlan(program.seal(), plan, context);
	});
	it("does not promote positive open target matches into the measured budget", () => {
		const program = analysisProgram();
		const open = appendBudgetCaller(program, 2, false, true);
		const closed = appendBudgetCaller(program, 2, false);
		appendLeaf(program);
		const context = programAnalysisContext();
		const analyses = new CoreAnalysisManager(
			program,
			context,
			new CoreOptimizationReportBuilder(program),
		);
		const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
			scope: "program",
		});
		const plan = buildCoreOptimizationPlan(
			program,
			analyses,
			summaries,
			[...program.functionIds()],
			{
				context,
				pgo: {
					digest: "guarded-target-matches",
					functionEntries: () => 0,
					callAttempts: (caller) => (caller === open.function ? 1_000 : 1),
					guardedCallHits: (caller) => (caller === open.function ? 100 : undefined),
				},
				budgets: {
					perSiteExpansions: 1,
					perCallerExpansions: 4,
					perCallerGeneratedCode: 4,
					perCallerCompilerWork: 100,
					programGeneratedCode: 1,
					programCompilerWork: 100,
				},
			},
		);
		expect(
			projectCoreSpecializationRecipes(plan.recipes).filter(
				(recipe) => recipe.kind === "guarded-direct-call",
			),
		).toEqual([
			expect.objectContaining({ function: closed.function, anchors: [closed.call] }),
		]);
		verifyCoreOptimizationPlan(program.seal(), plan, context);
	});

	it.each([
		{ attempts: undefined, targetHits: undefined, selected: 1 },
		{ attempts: 1_000, targetHits: undefined, selected: 1 },
		{ attempts: 1_000, targetHits: 100, selected: 1 },
		{ attempts: 1_000, targetHits: 0, selected: 0 },
		{ attempts: 0, targetHits: undefined, selected: 0 },
	])(
		"keeps open guarded regions optional under $attempts attempts and $targetHits target hits",
		({ attempts, targetHits, selected }) => {
			const program = analysisProgram();
			const open = appendBudgetCaller(program, 1, false, true);
			appendLeaf(program);
			const context = programAnalysisContext();
			const analyses = new CoreAnalysisManager(
				program,
				context,
				new CoreOptimizationReportBuilder(program),
			);
			const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
				scope: "program",
			});
			expect(summaries.targets.site(open.function, open.call)?.open).toBe(true);
			const plan = buildCoreOptimizationPlan(
				program,
				analyses,
				summaries,
				[...program.functionIds()],
				{
					context,
					pgo: {
						digest: "open-region-attempts",
						functionEntries: () => 0,
						callAttempts: () => attempts,
						guardedCallHits: () => targetHits,
					},
					budgets: {
						perSiteExpansions: 1,
						perCallerExpansions: 4,
						perCallerGeneratedCode: 4,
						perCallerCompilerWork: 100,
						programGeneratedCode: 20,
						programCompilerWork: 100,
					},
				},
			);
			const regions = projectCoreSpecializationRecipes(plan.recipes).filter(
				(recipe) => recipe.kind === "guarded-direct-call",
			);
			expect(regions).toHaveLength(selected);
			if (selected > 0)
				expect(regions[0]).toMatchObject({
					function: open.function,
					anchors: [open.call],
					fallback: "canonical-core",
				});
			verifyCoreOptimizationPlan(program.seal(), plan, context);
		},
	);

	it("preserves representation joins when inlining represented returns", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const merge = caller.createBlock([{ representation: "boxed" }]);
		const [callee] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
		const [result] = caller.appendInstruction(entry, "call", [callee!, receiver!]);
		caller.setTerminator(entry, {
			kind: "jump",
			edge: { block: merge, arguments: [result!] },
		});
		const joined = inspectCoreBlockParameters(caller, merge)[0]!.value;
		caller.setTerminator(merge, { kind: "return", value: joined });
		const callerId = caller.finish(entry).function;

		const target = new CoreFunctionBuilder(program);
		const targetEntry = target.createBlock();
		const [returned] = target.appendInstruction(targetEntry, "createBoolean", [], {
			attributes: { value: false },
			outputRepresentations: ["boolean"],
		});
		target.setTerminator(targetEntry, { kind: "return", value: returned! });
		target.finish(targetEntry);

		const transformed = runTransforms(program);
		expect(callInstructions(program, callerId)).toEqual([]);
		expect(transformed.statistics.appliedByKind.inline).toBe(1);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("inlines guarded base construction while retaining unsupported fallbacks", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Empty {}
				class Base { field = 1; }
				class Derived extends Base {}
				function hot(limit) {
					let value;
					for (let index = 0; index < limit; index++) {
						value = new Empty();
						value = new Base();
					}
					return [value, new Derived()];
				}
				hot(10);`,
				"core-guarded-base-construction.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(
			operations.some(
				({ opcode, attributes }) =>
					opcode === "createBaseConstructReceiver" &&
					attributes.constructorSlotReserve === 1,
			),
		).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "defineProperty")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "construct")).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("maps direct new.target reads to the guarded callee", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Record {
					constructor(value) {
						this.value = value;
						this.target = new.target;
					}
				}
				function hot(value) { return new Record(value); }
				hot(10);`,
				"core-constructor-new-target.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "loadNewTarget")).toBe(false);
		expect(
			operations.some(({ opcode }) => opcode === "createBaseConstructReceiver"),
		).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "construct")).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("selects dynamic base-constructor returns after guarded inlining", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Record {
					constructor(value, returned) {
						this.value = value;
						return returned;
					}
				}
				function hot(value, returned) { return new Record(value, returned); }
				hot(10, null);`,
				"core-constructor-dynamic-return.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "baseConstructResult")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "construct")).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("elides a guarded receiver discarded by an explicit object return", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Record {
					constructor(value) {
						this.discarded = value;
						return { value };
					}
				}
				function hot(value) { return new Record(value); }
				hot(10);`,
				"core-constructor-object-return.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "guardBaseConstructorLayout")).toBe(
			true,
		);
		expect(
			operations.some(({ opcode }) => opcode === "createBaseConstructReceiver"),
		).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "storePropertyStatic")).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "construct")).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("scalarizes contained base construction behind a prototype-layout guard", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Pair {
					constructor(left, right) { this.left = left; this.right = right; }
				}
				function hot(limit) {
					let sum = 0;
					for (let index = 0; index < limit; index++) {
						const pair = new Pair(index, index + 1);
						sum += pair.left + pair.right;
					}
					return sum;
				}
				hot(10);`,
				"core-contained-base-construction.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		const guard = operations.find(
			({ opcode }) => opcode === "guardBaseConstructorLayout",
		);
		expect(guard?.attributes.keyStringIndices).toHaveLength(2);
		expect(operations.some(({ opcode }) => opcode === "construct")).toBe(true);
		expect(
			operations.some(
				({ opcode }) =>
					opcode === "createBaseConstructReceiver" || opcode === "createObjectShaped",
			),
		).toBe(false);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("scalarizes computed constructor values through the guarded SSA region", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Pair {
					constructor(value) {
						this.left = (value + 1) & 255;
						this.right = (value * 3) & 255;
					}
				}
				function hot(limit) {
					let sum = 0;
					for (let index = 0; index < limit; index++) {
						const pair = new Pair(index & 255);
						sum += pair.left + pair.right;
					}
					return sum;
				}
				hot(10);`,
				"core-computed-base-construction.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "guardBaseConstructorLayout")).toBe(
			true,
		);
		expect(
			operations.some(
				({ opcode }) =>
					opcode === "createBaseConstructReceiver" || opcode === "createObjectShaped",
			),
		).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "construct")).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("scalarizes an immediate read-only method behind a combined constructor guard", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Pair {
					constructor(left, right) { this.left = left; this.right = right; }
					sum() { return this.left + this.right; }
				}
				function hot(limit) {
					let sum = 0;
					for (let index = 0; index < limit; index++) {
						sum += new Pair(index, index + 1).sum();
					}
					return sum;
				}
				hot(10);`,
				"core-immediate-constructor-method.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		const layoutGuard = operations.find(
			({ opcode }) => opcode === "guardBaseConstructorLayout",
		);
		expect(layoutGuard?.attributes.keyStringIndices).toHaveLength(2);
		expect(layoutGuard?.attributes.methodStringIndex).toEqual(expect.any(Number));
		expect(layoutGuard?.attributes.methodFunctionIndex).toEqual(expect.any(Number));
		expect(
			operations.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(1);
		expect(
			operations.filter(
				({ opcode, attributes }) =>
					opcode === "loadPropertyStatic" &&
					attributes.stringIndex === layoutGuard?.attributes.methodStringIndex,
			),
		).toHaveLength(1);
		expect(operations.some(({ opcode }) => opcode === "createFunction")).toBe(false);
		expect(
			operations.some(
				({ opcode }) =>
					opcode === "createBaseConstructReceiver" || opcode === "createObjectShaped",
			),
		).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "construct")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "call")).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("retains allocation when an immediate method observes receiver identity", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Record {
					constructor(value) { this.value = value; }
					self() { return this; }
				}
				function hot(value) { return new Record(value).self().value; }
				hot(10);`,
				"core-immediate-constructor-method-identity.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "guardBaseConstructorLayout")).toBe(
			false,
		);
		expect(
			operations.some(({ opcode }) => opcode === "createBaseConstructReceiver"),
		).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("retains receiver stores when a computed field can run user coercion", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Record {
					constructor(value) { this.value = value + 1; }
				}
				function hot(value) {
					const record = new Record(value);
					return record.value;
				}
				hot({ valueOf() { return 2; } });`,
				"core-computed-constructor-coercion.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "guardBaseConstructorLayout")).toBe(
			false,
		);
		expect(
			operations.some(({ opcode }) => opcode === "createBaseConstructReceiver"),
		).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it.each([
		["inherited data", "pair.extra", "Pair.prototype.extra = 7;"],
		[
			"inherited accessor",
			"pair.extra",
			`Object.defineProperty(Pair.prototype, "extra", { get() { return 7; } });`,
		],
		["constructor identity", "pair.constructor", ""],
	])("retains allocation for %s reads", (_name, read, setup) => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Pair { constructor(value) { this.value = value; } }
				${setup}
				function hot(limit) {
					let result;
					for (let index = 0; index < limit; index++) {
						const pair = new Pair(index);
						result = ${read};
					}
					return result;
				}
				hot(10);`,
				"core-contained-base-inherited-read.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const operations = coreOperations(coreFunctionNamed(optimized!, "hot")!);
		expect(operations.some(({ opcode }) => opcode === "guardBaseConstructorLayout")).toBe(
			false,
		);
		expect(
			operations.some(({ opcode }) => opcode === "createBaseConstructReceiver"),
		).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("retains the callee source chain when inlining", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					function addOne(input) { return input + 1; }
					return addOne(value);
				}`,
				"core-inline-source-chain.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		const addOne = coreFunctionNamed(optimized!, "addOne")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "call")).toBe(false);
		const binary = coreOperations(outer).find(({ opcode }) => opcode === "binary")!;
		const source =
			optimized!.sourcePositions[outer.instructionSourcePosition(binary.id)!];
		expect(source?.inlinedFunctionIndex).toBe(addOne.id);
		expect(typeof source?.callerPosId).toBe("number");
	});

	it("retains closed callee facts across nested argument relocation", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer() {
					function leaf() { return 1; }
					function middle(target) { return target(); }
					return middle(leaf);
				}`,
				"core-inline-relocated-target.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			coreOperations(outer).some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 1,
			),
		).toBe(true);
	});

	it("does not relocate callee activation reads into the caller", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function captured(input) {
					function closure() { return input + 1; }
					return closure();
				}
				function counted(value) {
					function inner() { return arguments.length; }
					return value + inner(1, 2);
				}
				captured(13);
				counted(3);`,
				"core-inline-activation.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const captured = coreFunctionNamed(optimized!, "captured")!;
		const counted = coreFunctionNamed(optimized!, "counted")!;
		expect(coreOperations(captured).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(coreOperations(captured).some(({ opcode }) => opcode === "loadCaptured")).toBe(
			false,
		);
		expect(coreOperations(counted).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(
			coreOperations(counted).some(({ opcode }) => opcode === "loadArgumentCount"),
		).toBe(false);
	});

	it("sinks one-shot captured callbacks into guarded fallbacks", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`let enabled = false;
				function invoke(callback) {
					const value = callback();
					return enabled ? value + 1 : value;
				}
				function outer(input) {
					let result = 0;
					for (let index = 0; index < 10; index++) {
						const value = input + index;
						result += invoke(() => value + 1);
					}
					return result;
				}
				outer(3);`,
				"core-inline-captured-callback.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		expect(operations.filter(({ opcode }) => opcode === "createFunction")).toHaveLength(
			1,
		);
		expect(
			operations.filter(
				({ opcode, attributes }) =>
					opcode === "call" &&
					attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] !== true,
			),
		).toHaveLength(0);
		expect(
			operations.some(
				({ opcode, attributes }) =>
					opcode === "call" &&
					attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true,
			),
		).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "loadCaptured")).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "envCopy")).toBe(false);
		const fallback = operations.find(
			({ opcode, attributes }) =>
				opcode === "call" && attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true,
		)!;
		expect(
			operations
				.filter(({ block }) => block === fallback.block)
				.map(({ opcode }) => opcode),
		).toEqual(["envPush", "storeCaptured", "createFunction", "call", "envPop"]);
	});

	it("virtualizes captured callbacks in guarded Array predicate loops", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function compare(groups) {
					let matches = 0;
					for (let index = 0; index < groups.length; index++) {
						const values = groups[index];
						const expected = groups[index];
						matches += values.every((value, position) => value === expected[position]) ? 1 : 0;
					}
					return matches;
				}
				globalThis.compare = compare;`,
				"core-inline-array-predicate-capture.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const compare = coreFunctionNamed(optimized!, "compare")!;
		const operations = coreOperations(compare);
		const fallback = operations.find(
			({ opcode, attributes }) =>
				opcode === "call" && attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true,
		)!;
		expect(operations.some(({ opcode }) => opcode === "loadCaptured")).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "envCopy")).toBe(false);
		expect(operations.filter(({ opcode }) => opcode === "createFunction")).toHaveLength(
			1,
		);
		expect(
			operations
				.filter(({ block }) => block === fallback.block)
				.map(({ opcode }) => opcode),
		).toEqual(["envPush", "storeCaptured", "createFunction", "call", "envPop"]);
	});

	it.each([
		{ name: "unknown callback", callback: "callback", mode: "full" as const },
		{
			name: "callback with its own loop",
			callback: "value => { while (value > 3) value--; return value === 3; }",
			mode: "full" as const,
		},
		{
			name: "no expansion budget",
			callback: "value => value === 3",
			mode: "development" as const,
		},
	])("keeps Array predicates compact with $name", ({ callback, mode }) => {
		const core = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`
			function count(groups, callback) {
				let total = 0;
				for (let index = 0; index < groups.length; index++) {
					total += groups[index].some(${callback}) ? 1 : 0;
				}
				return total;
			}
			globalThis.count = count;
		`,
				"compact-array-predicate.js",
			),
		);
		const hasExpansion = (program: CoreProgram) =>
			coreOperations(coreFunctionNamed(program, "count")!).some(
				({ opcode, attributes }) =>
					opcode === "loadIntrinsic" &&
					attributes.intrinsic === "__arrayIterationEligible",
			);
		expect(hasExpansion(core.program)).toBe(false);
		const result = optimizeCore(core, { verification: "per-pass", mode });
		expect(hasExpansion(result.compilation.program)).toBe(false);
	});

	it("preserves exception edges when expanding a hot Array predicate", () => {
		const core = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`
			function inspect(groups, predicate) {
				let total = 0;
				for (let index = 0; index < groups.length; index++) {
					try {
						if (groups[index].some(value => predicate(value))) total++;
					} catch {
						total--;
					}
				}
				return total;
			}
			globalThis.inspect = inspect;
		`,
				"exceptional-array-predicate.js",
			),
		);
		const { compilation } = optimizeCore(core, { verification: "per-pass" });
		expect(
			coreOperations(coreFunctionNamed(compilation.program, "inspect")!).some(
				({ opcode, attributes }) =>
					opcode === "loadIntrinsic" &&
					attributes.intrinsic === "__arrayIterationEligible",
			),
		).toBe(true);
	});

	it("guards and inlines hot global rest argument snapshots", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function sumRest(...values) {
					return values[0] + values[1] + values[2] + values[3];
				}
				function hot(value) {
					let checksum = 0;
					for (let index = 0; index < 10; index++) {
						checksum += sumRest(value, 3, 5, 7);
					}
					return checksum;
				}
				hot(1);`,
				"core-inline-rest-snapshots.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const hot = coreFunctionNamed(optimized!, "hot")!;
		const operations = coreOperations(hot);
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "loadArgument")).toBe(false);
	});

	it("materializes missing scalarized rest snapshots after exact inlining", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					function pick(...values) { return values[2]; }
					return pick(value);
				}
				outer(1);`,
				"core-inline-missing-rest-snapshot.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		expect(operations.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "loadArgument")).toBe(false);
		expect(operations.some(({ opcode }) => opcode === "createUndefined")).toBe(true);
	});

	it("binds scalarized rest snapshots in guarded inline fast paths", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					let handler = (...values) => values[0] + values[2];
					function install(other) { handler = other; }
					globalThis.install = install;
					return handler(value);
				}`,
				"core-guarded-inline-rest-snapshots.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(
			operations.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			),
		).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "createUndefined")).toBe(true);
		expect(operations.some(({ opcode }) => opcode === "loadArgument")).toBe(false);
	});

	it("omits unreachable guarded-call sites after non-linear rest inlining", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function identity(value) {
					for (let index = 0; index < 3; index++) value += index;
					return value;
				}
				function outer(value) {
					function read(first = identity(1), ...rest) {
						return identity(rest[0]);
					}
					return read(undefined, value);
				}
				outer(2);`,
				"core-inline-rest-guarded-plan.js",
			),
			{
				facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "loadArgument")).toBe(
			false,
		);
	});

	it("uses generated-code cost rather than a tiny call-count cap", () => {
		const nested = Array.from({ length: 16 }, () => "leaf(").join("");
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					function leaf(input) { return input + 1; }
					return ${nested}value${")".repeat(16)};
				}
				outer(1);`,
				"core-inline-tiny-chain.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(coreOperations(outer).some(({ opcode }) => opcode === "call")).toBe(false);
	});

	it("admits benchmark-sized local helpers by emitted-code cost", () => {
		let optimized: CoreProgram | undefined;
		let report: CoreOptimizationReport | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`const vector = (x, y, z) => ({ x, y, z });
				const scale = (value, factor) =>
					vector(value.x * factor, value.y * factor, value.z * factor);
				const add = (left, right) =>
					vector(left.x + right.x, left.y + right.y, left.z + right.z);
				const dot = (left, right) =>
					left.x * right.x + left.y * right.y + left.z * right.z;
				function hot(limit) {
					let checksum = 0;
					for (let index = 0; index < limit; index++) {
						const first = vector(index, index + 1, index + 2);
						const second = scale(first, 0.5);
						const result = add(first, second);
						checksum += dot(result, second);
					}
					return checksum;
				}
				hot(10);`,
				"core-guarded-inline-allocation-chain.js",
			),
			{
				coreInstrumentation: "full",
				afterCoreOptimization(program, _context, optimizationReport) {
					optimized = program;
					report = optimizationReport;
				},
			},
		);

		const hot = coreFunctionNamed(optimized!, "hot")!;
		const instructions = coreOperations(hot);
		expect(instructions.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			instructions.some(
				({ opcode }) => opcode === "createObject" || opcode === "createObjectShaped",
			),
		).toBe(false);
		expect(report!.transforms.generatedCodeConsumed).toBeLessThanOrEqual(39);
		expect(report!.transforms.declinedByReason["generated-code-cost"]).toBe(0);
	});

	it("inlines the known target of an open captured callee behind a generic fallback", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					let handler = (input) => input + 10;
					function install(other) { handler = other; }
					globalThis.install = install;
					try { return handler(value) * 2; }
					catch (error) { return error; }
				}`,
				"core-guarded-captured-call.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		const handler = coreFunctionNamed(optimized!, "handler")!;
		const calls = coreOperations(outer).filter(({ opcode }) => opcode === "call");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(calls[0]!.attributes.calleeTargets).toBeUndefined();
		const guard = coreOperations(outer).find(
			({ opcode }) => opcode === "guardFunctionIndex",
		)!;
		expect(guard.attributes.functionIndex).toBe(handler.id);
		const branch = inspectCoreTerminatorPayload(
			outer,
			outer.blockTerminator(guard.block),
		);
		expect(branch.kind).toBe("branch");
		if (branch.kind !== "branch") throw new Error("expected guarded inline branch");
		expect(branch.condition).toBe(guard.outputs[0]);
		expect(branch.alternate.block).toBe(calls[0]!.block);
		const fastTerminator = inspectCoreTerminatorPayload(
			outer,
			outer.blockTerminator(branch.consequent.block),
		);
		const fallbackTerminator = inspectCoreTerminatorPayload(
			outer,
			outer.blockTerminator(branch.alternate.block),
		);
		expect(fastTerminator.kind).toBe("jump");
		expect(fallbackTerminator.kind).toBe("jump");
		if (fastTerminator.kind !== "jump" || fallbackTerminator.kind !== "jump")
			throw new Error("expected guarded inline join");
		expect(fastTerminator.edge.block).toBe(fallbackTerminator.edge.block);
		expect(inspectCoreBlockHandler(outer, branch.consequent.block)?.block).toBe(
			inspectCoreBlockHandler(outer, branch.alternate.block)?.block,
		);
		expect(inspectCoreBlockHandler(outer, fastTerminator.edge.block)?.block).toBe(
			inspectCoreBlockHandler(outer, branch.alternate.block)?.block,
		);
		expect(
			coreOperations(outer).some(
				({ block, opcode, attributes }) =>
					block === branch.consequent.block &&
					opcode === "binary" &&
					attributes.operator === "+",
			),
		).toBe(true);
		expect(calls[0]!.attributes.directFunctionIndex).toBeUndefined();
	});

	it("bridges scalar arguments into guarded non-linear callees", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(value) {
					let handler = (input, fallback) => {
						if (input === undefined) return "";
						if (fallback === undefined) return input;
						return input + fallback;
					};
					function install(other) { handler = other; }
					globalThis.install = install;
					try { return handler("", value) + "tail"; }
					catch (error) { return error; }
				}`,
				"core-guarded-inline-scalar-argument.js",
			),
			{
				coreVerification: "per-pass",
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);

		const outer = coreFunctionNamed(optimized!, "outer")!;
		const operations = coreOperations(outer);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(true);
		expect(
			operations.some(
				({ opcode, inputs, outputs }) =>
					opcode === "move" &&
					inputs.length === 1 &&
					outputs.length === 1 &&
					outer.valueRepresentation(inputs[0]!) === "string" &&
					outer.valueRepresentation(outputs[0]!) === "boxed",
			),
		).toBe(true);
	});

	it("guards and inlines a known class static method without assuming the property is closed", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Service { static run(value) { return value + 10; } }
				function caller(value) { return Service.run(value) * 2; }
				caller(1);`,
				"core-guarded-static-inline.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const caller = coreFunctionNamed(optimized!, "caller")!;
		const target = coreFunctionNamed(optimized!, "run")!;
		const operations = coreOperations(caller);
		const guard = operations.find(({ opcode }) => opcode === "guardFunctionIndex");
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(guard?.attributes.functionIndex).toBe(target.id);
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(fallback?.attributes.calleeTargets).toBeUndefined();
		expect(
			operations.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			),
		).toBe(true);
	});

	it("guards and inlines a unique class instance method in a loop", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Counter {
					constructor(offset) { this.offset = offset; }
					add(value) { return value + this.offset; }
				}
				function caller(counter, value) {
					let total = 0;
					for (let index = 0; index < 4; index++) total += counter.add(value + index);
					return total;
				}
				caller(new Counter(10), 1);`,
				"core-guarded-instance-inline.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const caller = coreFunctionNamed(optimized!, "caller")!;
		const target = coreFunctionNamed(optimized!, "add")!;
		const operations = coreOperations(caller);
		const guard = operations.find(({ opcode }) => opcode === "guardFunctionIndex");
		const fallback = operations.find(({ opcode }) => opcode === "call");
		expect(guard?.attributes.functionIndex).toBe(target.id);
		expect(fallback?.attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]).toBe(true);
		expect(fallback?.attributes.calleeTargets).toBeUndefined();
		expect(
			operations.some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			),
		).toBe(true);
	});

	it("plans guarded direct dispatch for a unique captured instance method", () => {
		let optimized: CoreProgram | undefined;
		let plan: CoreOptimizationPlan | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Counter {
					#add(value) { return value + 10; }
					run(value) { return this.#add(value); }
				}
				function caller(counter, value) {
					let total = 0;
					for (let index = 0; index < 4; index++) total += counter.run(value + index);
					return total;
				}
				caller(new Counter(), 1);`,
				"core-guarded-instance-direct.js",
			),
			{
				afterCoreOptimization(program, _context, _report, optimizationPlan) {
					optimized = program;
					plan = optimizationPlan;
				},
			},
		);
		expect(optimized).toBeDefined();
		const caller = coreFunctionNamed(optimized!, "caller")!;
		const target = coreFunctionNamed(optimized!, "run")!;
		const operations = coreOperations(caller);
		expect(operations.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(false);
		const call = operations.find(({ opcode }) => opcode === "call");
		expect(call).toBeDefined();
		expect(
			plan === undefined ? [] : projectCoreSpecializationRecipes(plan.recipes),
		).toContainEqual(
			expect.objectContaining({
				kind: "guarded-direct-call",
				function: caller.id,
				anchors: [call!.id],
				targetFunctions: [target.id],
			}),
		);
	});

	it("plans finite guarded dispatch for unrelated same-name instance methods", () => {
		let optimized: CoreProgram | undefined;
		let report: CoreOptimizationReport | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class Counter {
					run(value) { return value + 10; }
				}
				class Other {
					run(value) { return value * 3; }
				}
				const other = new Other();
				function caller(counter, value) {
					let total = 0;
					for (let index = 0; index < 4; index++) total += counter.run(value + index);
					return total + other.run(1);
				}
				caller(new Counter(), 1);`,
				"core-guarded-instance-collision.js",
			),
			{
				coreInstrumentation: "full",
				afterCoreOptimization(program, _context, optimizationReport) {
					optimized = program;
					report = optimizationReport;
				},
			},
		);

		const caller = coreFunctionNamed(optimized!, "caller")!;
		const operations = coreOperations(caller);
		expect(operations.some(({ opcode }) => opcode === "call")).toBe(true);
		expect(
			operations.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(2);
		expect(report!.transforms.appliedByKind["finite-dispatch"]).toBe(1);
		expect(
			new Set(
				operations
					.filter(({ opcode }) => opcode === "guardFunctionIndex")
					.map(({ attributes }) => attributes.functionIndex),
			),
		).toHaveProperty("size", 2);
	});

	it("finite-dispatches a private dense array of lexical-this callees", () => {
		let optimized: CoreProgram | undefined;
		let report: CoreOptimizationReport | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function caller(count) {
					const handlers = [
						(value) => value + 1,
						(value) => value * 3,
						(value) => value - 7,
						(value) => value ^ 85,
					];
					let total = 0;
					for (let index = 0; index < count; index++) {
						total += handlers[index & 3](index & 1023);
					}
					return total;
				}
				caller(10);`,
				"core-finite-array-dispatch.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({
						engine: { primordials: "locked", realms: false },
					}),
				),
				coreInstrumentation: "full",
				afterCoreOptimization(program, _context, optimizationReport) {
					optimized = program;
					report = optimizationReport;
				},
			},
		);

		const caller = coreFunctionNamed(optimized!, "caller")!;
		const operations = coreOperations(caller);
		expect(operations.some(({ opcode }) => opcode === "call")).toBe(false);
		expect(
			operations.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(3);
		expect(report!.transforms.appliedByKind["finite-dispatch"]).toBe(1);
		expect(
			[...optimized!.functionIds()].filter(
				(id) => optimized!.function(id).metadata.lexicalThis,
			),
		).toHaveLength(4);
	});

	it("keeps private arrays of receiver-observing functions on generic dispatch", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function caller(count) {
					const handlers = [
						function first(value) { this[0] = first; return value + 1; },
						function second(value) { return value + 2; },
					];
					let total = 0;
					for (let index = 0; index < count; index++) total += handlers[index & 1](index);
					return total;
				}
				caller(10);`,
				"core-private-array-receiver-mutation.js",
			),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({
						engine: { primordials: "locked", realms: false },
					}),
				),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const caller = coreFunctionNamed(optimized!, "caller")!;
		expect(coreOperations(caller).some(({ opcode }) => opcode === "call")).toBe(true);
		expect(
			coreOperations(caller).some(({ opcode }) => opcode === "guardFunctionIndex"),
		).toBe(false);
	});

	it("finite-dispatches bounded ambiguous names but leaves cold names generic", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`class First { add(value) { return value + 1; } }
				class Second { add(value) { return value + 2; } }
				function ambiguous(receiver, value) {
					let total = 0;
					for (let index = 0; index < 4; index++) total += receiver.add(value);
					return total;
				}
				class Unique { read(value) { return value + 3; } }
				function cold(receiver, value) { return receiver.read(value); }
				ambiguous(new First(), 1);
				ambiguous(new Second(), 1);
				cold(new Unique(), 1);`,
				"core-instance-inline-declines.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		expect(optimized).toBeDefined();
		const ambiguous = coreOperations(coreFunctionNamed(optimized!, "ambiguous")!);
		expect(
			ambiguous.filter(({ opcode }) => opcode === "guardFunctionIndex"),
		).toHaveLength(2);
		expect(ambiguous.some(({ opcode }) => opcode === "call")).toBe(true);
		const cold = coreOperations(coreFunctionNamed(optimized!, "cold")!);
		expect(cold.some(({ opcode }) => opcode === "guardFunctionIndex")).toBe(false);
		expect(cold.some(({ opcode }) => opcode === "call")).toBe(true);
	});

	it.each([
		[
			"a reused record",
			"total += rules[index % rules.length].quote(order); total += order.net;",
			"",
			"",
		],
		[
			"a representation-ineligible target",
			"total += rules[index % rules.length].quote(order);",
			"",
			"return Math.abs(order.net > 0);",
		],
		[
			"more than four live same-name methods",
			"total += rules[index % rules.length].quote(order);",
			"globalThis.extraQuotes = [{ quote(order) { return order.net + 4; } }, { quote(order) { return order.net + 5; } }];",
			"",
		],
	] as const)(
		"retains bounded open-hint dispatch for %s",
		(_name, loopBody, extra, methodBody) => {
			let optimized: CoreProgram | undefined;
			const body = methodBody || "return order.net + 1;";
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`class First { quote(order) { ${body} } }
					class Second { quote(order) { ${body} } }
					class Third { quote(order) { ${body} } }
					${extra}
					function run(rules, count) {
						let total = 0;
						for (let index = 0; index < count; index++) {
							const order = { net: index + 1, quantity: index + 2 };
							${loopBody}
						}
						return total;
					}
					run([new First(), new Second(), new Third()], 9);`,
					"core-open-hint-field-entry-control.js",
				),
				{
					facts: compilerProgramFactsFromConfig(
						resolveBuildConfig({
							engine: { primordials: "locked", realms: false },
						}),
					),
					afterCoreOptimization(program) {
						optimized = program;
					},
				},
			);

			const operations = coreOperations(coreFunctionNamed(optimized!, "run")!);
			expect(
				operations.filter(({ opcode }) => opcode === "guardFunctionIndex"),
			).toHaveLength(3);
			expect(
				operations.some(
					({ opcode, attributes }) =>
						opcode === "call" &&
						attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true,
				),
			).toBe(true);
		},
	);

	it("plans every finite target installed through a nested closure", () => {
		let optimized: CoreProgram | undefined;
		let plan: CoreOptimizationPlan | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function outer(reassign) {
					function handler() { return 1; }
					function replacement() { return 2; }
					const retarget = () => { handler = replacement; };
					if (reassign) retarget();
					return handler();
				}`,
				"core-finite-captured-call.js",
			),
			{
				afterCoreOptimization(program, _context, _report, optimizationPlan) {
					optimized = program;
					plan = optimizationPlan;
				},
			},
		);
		expect(optimized).toBeDefined();
		const outer = coreFunctionNamed(optimized!, "outer")!;
		const targets = [
			coreFunctionNamed(optimized!, "handler")!.id,
			coreFunctionNamed(optimized!, "replacement")!.id,
		].sort((left, right) => left - right);
		const selection =
			plan === undefined
				? undefined
				: projectCoreSpecializationRecipes(plan.recipes).find(
						(candidate) =>
							candidate.kind === "guarded-direct-call" &&
							candidate.function === outer.id &&
							candidate.targetFunctions.length === 2,
					);
		expect(selection?.targetFunctions).toEqual(targets);
		expect(selection?.fallback).toBe("canonical-core");
	});

	it("never inlines class constructors through ordinary calls", () => {
		let optimized: CoreProgram | undefined;
		let plan: CoreOptimizationPlan | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function callClosed(value) {
					class Closed { constructor(input) { return input + 1; } }
					return Closed(value);
				}
				function callOpen(value) {
					let Current = class Open { constructor(input) { return input + 2; } };
					function install(other) { Current = other; }
					globalThis.installClass = install;
					return Current(value);
				}
				callClosed(1);
				callOpen(1);`,
				"core-class-constructor-inline.js",
			),
			{
				afterCoreOptimization(program, _context, _report, optimizationPlan) {
					optimized = program;
					plan = optimizationPlan;
				},
			},
		);
		expect(optimized).toBeDefined();
		for (const [callerName, targetName] of [
			["callClosed", "Closed"],
			["callOpen", "Open"],
		] as const) {
			const caller = coreFunctionNamed(optimized!, callerName)!;
			const target = coreFunctionNamed(optimized!, targetName)!;
			const calls = coreOperations(caller).filter(({ opcode }) => opcode === "call");
			expect(calls).toHaveLength(1);
			expect(
				coreOperations(caller).some(
					({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
				),
			).toBe(false);
			expect(
				plan === undefined ? [] : projectCoreSpecializationRecipes(plan.recipes),
			).toContainEqual(
				expect.objectContaining({
					kind: "guarded-direct-call",
					function: caller.id,
					anchors: [calls[0]!.id],
					targetFunctions: [target.id],
				}),
			);
		}
	});

	it.each([
		["early returns", "if (value < 0) return -value; return value + 1;"],
		[
			"diamond",
			"let result; if (value < 0) result = -value; else result = value + 1; return result * 2;",
		],
	])("inlines bounded %s and preserves caller-local proofs", (_name, body) => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`
			function outer(value) {
				function helper(input) { const value = +input; ${body} }
				return helper(value);
			}`,
				"core-inline-dag.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(callInstructions(optimized!, outer.id)).toEqual([]);
		expect(
			coreOperations(outer).some(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "<",
			),
		).toBe(true);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
		for (const operation of coreOperations(outer)) {
			const refinement = outer.instructionEffectRefinement(operation.id);
			if (refinement === undefined) continue;
			expect(outer.fact(refinement.proof).claims).toContainEqual(
				expect.objectContaining({ kind: "effect", instruction: operation.id }),
			);
		}
	});

	it("keeps cyclic and exception-handling helpers outside the acyclic inliner", () => {
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`
			function outer(value) {
				function cycle(input) { while (input > 2) input /= 2; return input; }
				function handled(input) { try { return +input; } catch { return 0; } }
				return cycle(value) + handled(value);
			}`,
				"core-inline-rejected-graphs.js",
			),
			{
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const outer = coreFunctionNamed(optimized!, "outer")!;
		expect(callInstructions(optimized!, outer.id)).toHaveLength(2);
		verifyCoreProgram(optimized!, { stage: "pre-target" });
	});

	it("keeps the generic call and records its decision only in the plan", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		appendLeaf(program);
		const result = runTransforms(program, TINY_CODE_BUDGET);
		const fn = program.function(caller.function);
		const [call] = callInstructions(program, caller.function);
		expect(call).toBeDefined();
		const attributes = fn.instructionAttributes(call!);
		expect(attributes.directFunctionIndex).toBeUndefined();
		expect(attributes.calleeTargets).toBeUndefined();
		expect(attributes.callParameterEscape).toBeUndefined();
		expect(attributes.callParameterContainment).toBeUndefined();
		expect(attributes.callReturnProvenance).toBeUndefined();
		expect(attributes.callReturnRepresentation).toBeUndefined();
		expect(result.statistics.considered).toBe(0);
		expect(result.statistics.declinedByReason["generated-code-cost"] ?? 0).toBe(0);
		expect(result.plan.statistics.discovery.attempted).toBe(0);
		expect(
			result.plan.statistics.discovery.skippedByReason["generated-code-cost"],
		).toBeGreaterThan(0);
		expect(projectCoreSpecializationRecipes(result.plan.recipes)).toEqual([]);
	});

	it("shares the whole-program generated-code budget with late specialization", () => {
		const program = analysisProgram();
		const inlinedCaller = appendCaller(program, 2);
		const specializedCaller = appendCaller(program, 3);
		appendLeaf(program);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const consequent = builder.createBlock();
		const alternate = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: consequent, arguments: [] },
			alternate: { block: alternate, arguments: [] },
		});
		for (const block of [consequent, alternate]) {
			const [value] = builder.appendInstruction(block, "createUndefined", []);
			builder.setTerminator(block, { kind: "return", value: value! });
		}
		builder.finish(entry);

		const result = runTransforms(program, {
			perSiteExpansions: 1,
			perCallerExpansions: 8,
			perCallerGeneratedCode: 8,
			perCallerCompilerWork: 1_000,
			programGeneratedCode: 1,
			programCompilerWork: 10_000,
		});
		expect(callInstructions(program, inlinedCaller.function)).toEqual([]);
		expect(callInstructions(program, specializedCaller.function)).toHaveLength(1);
		expect(projectCoreSpecializationRecipes(result.plan.recipes)).toEqual([]);
		expect(result.statistics.generatedCodeConsumed).toBe(1);
		expect(
			result.report
				.finish(program, result.plan)
				.analyses.find(({ analysis }) => analysis === "program-flow-valueKinds")
				?.recomputations,
		).toBeUndefined();
		const refreshed = result.analyses.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, {
			scope: "program",
		});
		expect(refreshed.flowRevision).toBe(program.programFlowRevision);
		const fresh = new CoreAnalysisManager(
			program,
			programAnalysisContext(),
			new CoreOptimizationReportBuilder(program),
		).get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" }).kinds;
		for (const id of program.functionIds())
			expect(refreshed.kinds.summary(id)).toEqual(fresh.summary(id));
		expect(result.plan.statistics.discovery.attempted).toBe(0);
		expect(
			result.plan.statistics.discovery.skippedByReason["generated-code-cost"],
		).toBeGreaterThan(0);
	});

	it("terminates a recursive inline candidate by identity", () => {
		const program = analysisProgram();
		appendCaller(program, 0);
		const result = runTransforms(program);
		expect(callInstructions(program, 0)).toHaveLength(1);
		expect(result.statistics.declinedByReason.recursive).toBe(1);
	});

	it("publishes finite guarded dispatch while sharing the original fallback", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{ representation: "boxed" }]);
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			outputRepresentations: ["boolean"],
			attributes: { value: true },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [first] = builder.appendInstruction(left, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [first!] },
		});
		const [second] = builder.appendInstruction(right, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [second!] },
		});
		const callee = inspectCoreBlockParameters(builder, join)[0]!.value;
		const [receiver] = builder.appendInstruction(join, "createUndefined", []);
		const [result] = builder.appendInstruction(join, "call", [callee, receiver!]);
		builder.setTerminator(join, { kind: "return", value: result! });
		builder.finish(entry);
		appendLeaf(program);
		appendLeaf(program);

		const transformed = runTransforms(program);
		const fn = program.function(0 as never);
		const [call] = callInstructions(program, 0);
		expect(fn.instructionAttributes(call!).guardedFunctionIndices).toBeUndefined();
		expect(callInstructions(program, 0)).toHaveLength(1);
		expect(projectCoreSpecializationRecipes(transformed.plan.recipes)).toMatchObject([
			{ kind: "guarded-direct-call", targetFunctions: [1, 2] },
		]);
	});

	it("discovers callsites exposed by an earlier inline without global rounds", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendCaller(program, 2);
		appendLeaf(program);
		const transformed = runTransforms(program);
		expect(callInstructions(program, 0)).toEqual([]);
		expect(transformed.statistics.appliedByKind.inline).toBeGreaterThanOrEqual(2);
		expect(transformed.statistics.compilerWorkConsumed).toBeGreaterThan(0);
		expect(transformed.statistics.valueKindFunctionEvaluations).toBe(0);
	});

	it("folds local kinds through arithmetic, moves and joins without global propagation", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock([{}]);
		const [condition] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		for (const block of [left, right]) {
			const [number] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 3 },
			});
			const [sum] = builder.appendInstruction(block, "binary", [number!, number!], {
				attributes: { operator: "+" },
			});
			const [moved] = builder.appendInstruction(block, "move", [sum!]);
			builder.setTerminator(block, {
				kind: "jump",
				edge: { block: join, arguments: [moved!] },
			});
		}
		const [result] = builder.appendInstruction(
			join,
			"typeofCompare",
			[builder.blockParameterValue(join, 0)],
			{ attributes: { expected: "number" } },
		);
		builder.setTerminator(join, { kind: "return", value: result! });
		const fn = builder.finish(entry).function;
		const transformed = runTransforms(program);
		expect(transformed.statistics.valueKindFolds).toBe(1);
		expect(transformed.statistics.valueKindFunctionEvaluations).toBe(0);
		expect(coreOperations(program.function(fn))).toContainEqual(
			expect.objectContaining({ opcode: "createBoolean", attributes: { value: true } }),
		);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("keeps opaque observations without propagating unrelated script calls", () => {
		const program = analysisProgram();
		appendCaller(program, 2);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [object] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const stringIndex = builder.editor.appendStringConstants([[120]]);
		const [property] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex },
		});
		const [result] = builder.appendInstruction(entry, "typeofCompare", [property!], {
			attributes: { expected: "number" },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const fn = builder.finish(entry).function;
		appendLeaf(program);
		const transformed = runTransforms(program);
		expect(transformed.statistics.valueKindFolds).toBe(0);
		expect(transformed.statistics.valueKindFunctionEvaluations).toBe(0);
		expect(
			coreOperations(program.function(fn)).some(
				({ opcode }) => opcode === "typeofCompare",
			),
		).toBe(true);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("folds strict receiver observations using global call inputs", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const [callee] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = caller.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 7 },
		});
		const [called] = caller.appendInstruction(entry, "call", [callee!, receiver!]);
		caller.setTerminator(entry, { kind: "return", value: called! });
		caller.finish(entry);
		const leaf = new CoreFunctionBuilder(program, { metadata: { strict: true } });
		const body = leaf.createBlock();
		const [thisValue] = leaf.appendInstruction(body, "loadThis", []);
		const [result] = leaf.appendInstruction(body, "typeofCompare", [thisValue!], {
			attributes: { expected: "number" },
		});
		leaf.setTerminator(body, { kind: "return", value: result! });
		const fn = leaf.finish(body).function;
		const transformed = runTransforms(program);
		expect(transformed.statistics.valueKindFunctionEvaluations).toBeGreaterThan(0);
		expect(coreOperations(program.function(fn))).toContainEqual(
			expect.objectContaining({ opcode: "createBoolean", attributes: { value: true } }),
		);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("solves a cyclic join only when its comparison needs the fixed point", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const loop = builder.createBlock([{}]);
		const exit = builder.createBlock();
		const [seed] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: loop, arguments: [seed!] },
		});
		const value = builder.blockParameterValue(loop, 0);
		const [condition] = builder.appendInstruction(loop, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(loop, {
			kind: "branch",
			condition: condition!,
			consequent: { block: loop, arguments: [value] },
			alternate: { block: exit, arguments: [] },
		});
		const [result] = builder.appendInstruction(exit, "typeofCompare", [value], {
			attributes: { expected: "number" },
		});
		builder.setTerminator(exit, { kind: "return", value: result! });
		const fn = builder.finish(entry).function;
		const transformed = runTransforms(program);
		expect(transformed.statistics.valueKindFunctionEvaluations).toBeGreaterThan(0);
		expect(coreOperations(program.function(fn))).toContainEqual(
			expect.objectContaining({ opcode: "createBoolean", attributes: { value: true } }),
		);
		verifyCoreProgram(program, { stage: "pre-target" });
	});

	it("admits a new global type consumer after a local-only wave", () => {
		const program = analysisProgram();
		const caller = new CoreFunctionBuilder(program);
		const entry = caller.createBlock();
		const [callee] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		const [receiver] = caller.appendInstruction(entry, "createUndefined", []);
		const [argument] = caller.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 3 },
		});
		const [called] = caller.appendInstruction(entry, "call", [
			callee!,
			receiver!,
			argument!,
		]);
		caller.setTerminator(entry, { kind: "return", value: called! });
		caller.finish(entry);
		const leaf = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const body = leaf.createBlock([{}]);
		const parameter = leaf.blockParameterValue(body, 0);
		const [result] = leaf.appendInstruction(body, "createBoolean", [], {
			attributes: { value: false },
		});
		const target = leaf.bodyInstructionIds(body).at(-1)!;
		leaf.appendInstruction(body, "typeofCompare", [result!], {
			attributes: { expected: "boolean" },
		});
		leaf.setTerminator(body, { kind: "return", value: result! });
		const fn = leaf.finish(body).function;
		let introduced = false;
		const transformed = runTransforms(
			program,
			{ ...TINY_CODE_BUDGET, programGeneratedCode: 1_000 },
			undefined,
			(wave, functionId, editor) => {
				if (wave !== 0 || functionId !== fn) return;
				editor.replaceInstruction(target, "typeofCompare", [parameter], {
					attributes: { expected: "number" },
				});
				introduced = true;
			},
		);
		expect(introduced).toBe(true);
		expect(transformed.statistics.valueKindFunctionEvaluations).toBeGreaterThan(0);
		expect(coreOperations(program.function(fn))).toContainEqual(
			expect.objectContaining({ opcode: "createBoolean", attributes: { value: true } }),
		);
		verifyCoreProgram(program, { stage: "pre-target" });
	});
});
