import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	CORE_CALLEE_TARGETS_ATTRIBUTE,
	CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE,
	CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE,
	CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE,
	CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE,
	CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE,
	runCoreCrossCallTransforms,
} from "../src/compiler/core/core-cross-call-transforms.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CorePassManager } from "../src/compiler/core/core-pass-manager.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { CoreTransformCandidateService } from "../src/compiler/core/core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
} from "../src/compiler/core/core-transform-candidates.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
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
	const passes = new CorePassManager(program, context, analyses, report);
	const result = runCoreCrossCallTransforms(program, analyses, passes, limits);
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
	it("deduplicates semantic keys and enforces site, caller, and compiler-work limits", () => {
		const service = new CoreTransformCandidateService({
			perSiteExpansions: 1,
			perCallerExpansions: 1,
			perCallerGeneratedCode: 10,
			perCallerCompilerWork: 3,
			programGeneratedCode: 10,
			programCompilerWork: 3,
		});
		const candidate = (key: string, site: number, work = 1): CoreTransformCandidate => ({
			key,
			kind: "inline",
			caller: 0 as never,
			site: site as never,
			targets: [1 as never],
			generatedCodeCost: 1,
			compilerWorkCost: work,
			expansive: true,
		});
		expect(service.offer(candidate("same", 1))).toBe(true);
		expect(service.offer(candidate("same", 1))).toBe(false);
		const first = service.next()!;
		expect(service.admit(first)).toBeUndefined();
		service.recordApplied(first);
		expect(service.admit(candidate("same-site", 1))).toBe("expansion-limit");
		expect(service.admit(candidate("same-caller", 2))).toBe("expansion-limit");

		const compilerLimited = new CoreTransformCandidateService({
			perSiteExpansions: 2,
			perCallerExpansions: 2,
			perCallerGeneratedCode: 10,
			perCallerCompilerWork: 1,
			programGeneratedCode: 10,
			programCompilerWork: 1,
		});
		expect(compilerLimited.admit(candidate("work", 1, 2))).toBe("compiler-work-cost");

		const ordered = new CoreTransformCandidateService();
		for (const key of ["c", "a", "b"]) ordered.offer(candidate(key, 1));
		expect(ordered.next()?.key).toBe("a");
		ordered.offer(candidate("aa", 1));
		expect([ordered.next()?.key, ordered.next()?.key, ordered.next()?.key]).toEqual([
			"aa",
			"b",
			"c",
		]);
	});

	it("separately discovers metadata and inline candidates", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendLeaf(program);
		const result = runTransforms(program);
		expect(callInstructions(program, 0)).toEqual([]);
		expect(result.statistics.appliedByKind).toMatchObject({
			"call-refresh": 1,
			inline: 1,
		});
		expect(result.statistics.instructionsIntroduced).toBe(1);
		expect(result.statistics.generatedCodeConsumed).toBe(1);
		expect(result.statistics.callGraphFunctionsAnalyzed).toBeGreaterThan(2);
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
		expect(calls[0]!.attributes[CORE_CALLEE_TARGETS_ATTRIBUTE]).toMatchObject({
			functions: [handler.id],
			anyScript: false,
			opaque: true,
		});
		const guard = coreOperations(outer).find(
			({ opcode }) => opcode === "guardFunctionIndex",
		)!;
		expect(guard.attributes.functionIndex).toBe(handler.id);
		const branch = outer.terminatorPayload(outer.blockTerminator(guard.block));
		expect(branch.kind).toBe("branch");
		if (branch.kind !== "branch") throw new Error("expected guarded inline branch");
		expect(branch.condition).toBe(guard.outputs[0]);
		expect(branch.alternate.block).toBe(calls[0]!.block);
		const fastTerminator = outer.terminatorPayload(
			outer.blockTerminator(branch.consequent.block),
		);
		const fallbackTerminator = outer.terminatorPayload(
			outer.blockTerminator(branch.alternate.block),
		);
		expect(fastTerminator.kind).toBe("jump");
		expect(fallbackTerminator.kind).toBe("jump");
		if (fastTerminator.kind !== "jump" || fallbackTerminator.kind !== "jump")
			throw new Error("expected guarded inline join");
		expect(fastTerminator.edge.block).toBe(fallbackTerminator.edge.block);
		expect(outer.blockHandler(branch.consequent.block)?.block).toBe(
			outer.blockHandler(branch.alternate.block)?.block,
		);
		expect(outer.blockHandler(fastTerminator.edge.block)?.block).toBe(
			outer.blockHandler(branch.alternate.block)?.block,
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
		expect(fallback?.attributes[CORE_CALLEE_TARGETS_ATTRIBUTE]).toMatchObject({
			functions: [target.id],
			anyScript: false,
			opaque: true,
		});
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
		const selection = plan?.specializations.find(
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
			expect(plan?.specializations).toContainEqual(
				expect.objectContaining({
					kind: "guarded-direct-call",
					function: caller.id,
					anchors: [calls[0]!.id],
					targetFunctions: [target.id],
				}),
			);
		}
	});

	it("retains call facts and a generic call when generated-code budget declines inline", () => {
		const program = analysisProgram();
		const caller = appendCaller(program, 1);
		appendLeaf(program);
		const result = runTransforms(program, TINY_CODE_BUDGET);
		const fn = program.function(caller.function);
		const [call] = callInstructions(program, caller.function);
		expect(call).toBeDefined();
		const attributes = fn.instructionAttributes(call!);
		expect(attributes.directFunctionIndex).toBeUndefined();
		expect(attributes[CORE_CALLEE_TARGETS_ATTRIBUTE]).toMatchObject({
			functions: [1],
			anyScript: false,
			opaque: false,
		});
		expect(attributes[CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE]).toEqual([]);
		expect(attributes[CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE]).toEqual([]);
		expect(attributes[CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE]).toBe("primitive");
		expect(attributes[CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE]).toBe("boxed");
		expect(result.statistics.declinedByReason["generated-code-cost"]).toBe(1);
		expect(result.plan.specializations).toMatchObject([
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
		const callee = builder.blockParameters(join)[0]!.value;
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
		expect(transformed.plan.specializations).toMatchObject([
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
