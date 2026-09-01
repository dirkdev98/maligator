import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import {
	CORE_CALLEE_TARGETS_ATTRIBUTE,
	CORE_CALL_PARAMETER_CONTAINMENT_ATTRIBUTE,
	CORE_CALL_PARAMETER_ESCAPE_ATTRIBUTE,
	CORE_CALL_RETURN_PROVENANCE_ATTRIBUTE,
	CORE_CALL_RETURN_REPRESENTATION_ATTRIBUTE,
	runCoreCrossCallTransforms,
} from "../src/compiler/core/core-cross-call-transforms.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CorePassManager } from "../src/compiler/core/core-pass-manager.ts";
import { CoreTransformCandidateService } from "../src/compiler/core/core-transform-candidates.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
} from "../src/compiler/core/core-transform-candidates.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
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
	return runCoreCrossCallTransforms(program, analyses, passes, limits);
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
		expect(compilerLimited.admit(candidate("work", 1, 2))).toBe(
			"compiler-work-cost",
		);
	});

	it("separately discovers metadata, direct-call, and inline candidates", () => {
		const program = analysisProgram();
		appendCaller(program, 1);
		appendLeaf(program);
		const result = runTransforms(program);
		expect(callInstructions(program, 0)).toEqual([]);
		expect(result.statistics.appliedByKind).toMatchObject({
			"call-refresh": 1,
			"finite-dispatch": 1,
			inline: 1,
		});
		expect(result.statistics.instructionsIntroduced).toBe(1);
		expect(result.statistics.generatedCodeConsumed).toBe(1);
		expect(result.statistics.callGraphFunctionsAnalyzed).toBeGreaterThan(2);
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
		expect(attributes.directFunctionIndex).toBe(1);
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
		builder.setTerminator(left, { kind: "jump", edge: { block: join, arguments: [first!] } });
		const [second] = builder.appendInstruction(right, "createFunction", [], {
			attributes: { functionIndex: 2 },
		});
		builder.setTerminator(right, { kind: "jump", edge: { block: join, arguments: [second!] } });
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
		expect(fn.instructionAttributes(call!).guardedFunctionIndices).toEqual([1, 2]);
		expect(callInstructions(program, 0)).toHaveLength(1);
		expect(transformed.statistics.appliedByKind["finite-dispatch"]).toBe(1);
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
