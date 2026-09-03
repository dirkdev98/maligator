import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { runCoreCrossCallTransforms } from "../src/compiler/core/core-cross-call-transforms.ts";
import {
	CoreFunctionOptimizationResources,
	CoreFunctionOptimizationSession,
} from "../src/compiler/core/core-function-optimization-session.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { projectCoreSpecializationRecipes } from "../src/compiler/core/core-specialization-recipes.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { CoreTransformCandidateService } from "../src/compiler/core/core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
} from "../src/compiler/core/core-transform-candidates.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
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

function runTransforms(program: CoreProgram, limits?: CoreTransformBudgetLimits) {
	const context = programAnalysisContext();
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	const resources = new CoreFunctionOptimizationResources(program);
	const result = runCoreCrossCallTransforms(
		program,
		analyses,
		(wave, functionId, editor) =>
			new CoreFunctionOptimizationSession(
				program,
				context,
				report,
				resources,
				functionId,
				{ crossCallWave: wave },
			).optimizeCrossCall(editor),
		limits,
	);
	return {
		...result,
		plan: buildCoreOptimizationPlan(program, analyses, result.summaries, [
			...program.functionIds(),
		]),
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

const TINY_CODE_BUDGET: CoreTransformBudgetLimits = {
	perSiteExpansions: 1,
	perCallerExpansions: 8,
	perCallerGeneratedCode: 0,
	perCallerCompilerWork: 1_000,
	programGeneratedCode: 0,
	programCompilerWork: 10_000,
};

describe("bounded Core cross-call transforms", () => {
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
		expect(report!.transforms.appliedByKind.inline).toBe(8);
		expect(report!.transforms.generatedCodeConsumed).toBe(39);
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
		expect(result.statistics.declinedByReason["generated-code-cost"]).toBe(1);
		expect(projectCoreSpecializationRecipes(result.plan.recipes)).toMatchObject([
			{ kind: "guarded-direct-call", targetFunctions: [1] },
		]);
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
	});
});
