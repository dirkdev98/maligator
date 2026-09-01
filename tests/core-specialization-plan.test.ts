import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-ir-summaries.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function planning(program: CoreProgram, liveFunctions: ReadonlyArray<CoreFunctionId>) {
	const context = programAnalysisContext();
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	return {
		context,
		analyses,
		summaries,
		plan: buildCoreOptimizationPlan(program, analyses, summaries, liveFunctions),
	};
}

function numericProgram(): { readonly program: CoreProgram; readonly function: CoreFunctionId } {
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
	const builder = new CoreFunctionBuilder(program, { metadata: { sourcePath: "/entry.js" } });
	const entry = builder.createBlock();
	const [left] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 2 },
		outputRepresentations: ["f64"],
	});
	const [right] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 3 },
		outputRepresentations: ["f64"],
	});
	const [product] = builder.appendInstruction(entry, "mathBinaryNumber", [left!, right!], {
		attributes: { operator: "*" },
		outputRepresentations: ["f64"],
	});
	const [sum] = builder.appendInstruction(entry, "mathBinaryNumber", [product!, right!], {
		attributes: { operator: "+" },
		outputRepresentations: ["f64"],
	});
	builder.setTerminator(entry, { kind: "return", value: sum! });
	const { function: functionId } = builder.finish(entry);
	return { program, function: functionId };
}

function directEntryProgram(): {
	readonly program: CoreProgram;
	readonly caller: CoreFunctionId;
	readonly callee: CoreFunctionId;
} {
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
	const callerBuilder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const callerEntry = callerBuilder.createBlock();
	const [calleeValue] = callerBuilder.appendInstruction(callerEntry, "createFunction", [], {
		attributes: { functionIndex: 1 },
	});
	const [receiver] = callerBuilder.appendInstruction(callerEntry, "createUndefined", []);
	const [result] = callerBuilder.appendInstruction(
		callerEntry,
		"call",
		[calleeValue!, receiver!],
		{ attributes: { directFunctionIndex: 1 } },
	);
	callerBuilder.setTerminator(callerEntry, { kind: "return", value: result! });
	const { function: caller } = callerBuilder.finish(callerEntry);

	const calleeBuilder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const calleeEntry = calleeBuilder.createBlock();
	const [answer] = calleeBuilder.appendInstruction(calleeEntry, "createF64", [], {
		attributes: { value: 42 },
		outputRepresentations: ["f64"],
	});
	calleeBuilder.setTerminator(calleeEntry, { kind: "return", value: answer! });
	const { function: callee } = calleeBuilder.finish(calleeEntry);
	return { program, caller, callee };
}

describe("late Core specialization plan", () => {
	it("selects deterministically and charges the shared code/work budgets", () => {
		const { program, function: functionId } = numericProgram();
		const first = planning(program, [functionId]);
		const second = buildCoreOptimizationPlan(
			program,
			first.analyses,
			first.summaries,
			[functionId],
		);
		expect(second).toEqual(first.plan);
		expect(first.plan.specializations).toHaveLength(1);
		expect(first.plan.specializations[0]).toMatchObject({
			kind: "numeric-fusion",
			function: functionId,
			fallback: "canonical-core",
			composition: "overlay",
		});
		expect(first.plan.statistics.generatedCodeConsumed).toBeGreaterThan(0);
		expect(first.plan.statistics.compilerWorkConsumed).toBeGreaterThan(0);

		const declined = buildCoreOptimizationPlan(
			program,
			first.analyses,
			first.summaries,
			[functionId],
			{
				budgets: {
					perSiteExpansions: 1,
					perCallerExpansions: 1,
					perCallerGeneratedCode: 0,
					perCallerCompilerWork: 1_000,
					programGeneratedCode: 0,
					programCompilerWork: 1_000,
				},
			},
		);
		expect(declined.specializations).toEqual([]);
		expect(declined.statistics.declinedByPlanReason["generated-code-cost"]).toBe(1);
	});

	it("rejects stale versions and conflicting exclusive ownership", () => {
		const { program, function: functionId } = numericProgram();
		const { plan } = planning(program, [functionId]);
		const sealed = program.seal();
		expect(() => verifyCoreOptimizationPlan(sealed, plan)).not.toThrow();
		const stale: CoreOptimizationPlan = {
			...plan,
			version: { ...plan.version, key: `${plan.version.key}:stale` },
		};
		expect(() => verifyCoreOptimizationPlan(sealed, stale)).toThrow(/plan version/);
		const selected = plan.specializations[0]!;
		const conflict: CoreOptimizationPlan = {
			...plan,
			specializations: [
				{ ...selected, composition: "exclusive" },
				{ ...selected, id: `${selected.id}:duplicate`, composition: "exclusive" },
			],
		};
		expect(() => verifyCoreOptimizationPlan(sealed, conflict)).toThrow(/conflicts/);
	});

	it("relocates direct entries into native execution while retaining generic Core", () => {
		const { program, caller, callee } = directEntryProgram();
		const { context, plan } = planning(program, [caller, callee]);
		expect(plan.directEntries).toMatchObject([
			{
				id: 0,
				function: callee,
				parameterRepresentations: [],
				resultRepresentation: "f64",
				fallback: "canonical-core",
			},
		]);
		const coreCall = plan.directEntries[0]!.callSites[0]!;
		expect(program.function(caller).instructionAttributes(coreCall.instruction))
			.not.toHaveProperty("directEntryId");
		const sealed = program.seal();
		const execution = lowerCoreCompilationToExecution({ program: sealed, context, plan });
		expect(execution.functions[callee]!.directEntries).toMatchObject([
			{ id: 0, resultRepresentation: "number" },
		]);
		const loweredCall = execution.functions[caller]!.blocks
			.flatMap(({ instructions }) => instructions)
			.find(({ type }) => type === "call");
		expect(loweredCall).toMatchObject({
			type: "call",
			directFunctionIndex: callee,
			directEntryId: 0,
		});

		const genericOnly: CoreOptimizationPlan = {
			...plan,
			directEntries: [],
			specializations: [],
			statistics: {
				...plan.statistics,
				considered: 0,
				applied: 0,
				declined: 0,
				discoveredByKind: {},
				selectedByKind: {},
				declinedByPlanReason: {},
				generatedCodeConsumed: 0,
				compilerWorkConsumed: 0,
			},
		};
		const generic = lowerCoreCompilationToExecution({
			program: sealed,
			context,
			plan: genericOnly,
		});
		expect(generic.functions.every((fn) => fn.directEntries.length === 0)).toBe(true);
	});
});
