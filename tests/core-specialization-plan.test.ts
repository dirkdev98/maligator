import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	buildCoreLocalOptimizationPlanInput,
	buildCoreOptimizationPlan,
	coreLocalSpecializationFeatureIndex,
} from "../src/compiler/core/core-ir-region-selection.ts";
import {
	corePlanAdmissionMode,
	verifyCoreOptimizationPlan,
} from "../src/compiler/core/core-ir-region-validity.ts";
import type {
	CoreOptimizationPlan,
	CorePlanSpecialization,
	VerifiedCoreOptimizationPlan,
} from "../src/compiler/core/core-ir-regions.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
} from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-program-flow-analysis.ts";
import {
	buildCoreSpecializationRecipeTable,
	coreSpecializationRecipeStorageStatistics,
	projectCoreSpecializationRecipes,
} from "../src/compiler/core/core-specialization-recipes.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function planSpecializations(
	plan: CoreOptimizationPlan,
): ReadonlyArray<CorePlanSpecialization> {
	return projectCoreSpecializationRecipes(plan.recipes);
}

function withPlanSpecializations(
	plan: CoreOptimizationPlan,
	specializations: ReadonlyArray<CorePlanSpecialization>,
): CoreOptimizationPlan {
	return {
		...plan,
		recipes: buildCoreSpecializationRecipeTable(specializations),
	};
}

function planning(program: CoreProgram, liveFunctions: ReadonlyArray<CoreFunctionId>) {
	const context = programAnalysisContext();
	const report = new CoreOptimizationReportBuilder(program);
	const analyses = new CoreAnalysisManager(program, context, report);
	const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, {
		scope: "program",
	});
	return {
		context,
		analyses,
		summaries,
		plan: buildCoreOptimizationPlan(program, analyses, summaries, liveFunctions, {
			context,
		}),
	};
}

function stringSplitProgram(): {
	readonly program: CoreProgram;
	readonly function: CoreFunctionId;
	readonly call: CoreInstructionId;
} {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[0x73, 0x70, 0x6c, 0x69, 0x74], [0x3b]],
	});
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const entry = builder.createBlock();
	const [receiver] = builder.appendInstruction(entry, "createString", [], {
		attributes: { stringIndex: 1 },
	});
	const [property] = builder.appendInstruction(entry, "loadPropertyStatic", [receiver!], {
		attributes: { stringIndex: 0 },
	});
	const [separator] = builder.appendInstruction(entry, "createString", [], {
		attributes: { stringIndex: 1 },
	});
	const [result] = builder.appendInstruction(entry, "call", [
		property!,
		receiver!,
		separator!,
	]);
	const [key] = builder.appendInstruction(entry, "createNumber", [], {
		attributes: { value: 0 },
	});
	const [element] = builder.appendInstruction(entry, "loadProperty", [result!, key!]);
	builder.setTerminator(entry, { kind: "return", value: element! });
	const { function: functionId } = builder.finish(entry);
	const call = [...program.function(functionId).bodyInstructionIds(entry)].find(
		(instruction) =>
			program.function(functionId).instructionOpcodeName(instruction) === "call",
	)!;
	return { program, function: functionId, call };
}

function numericProgram(
	startOperator = "*",
	finishOperator = "+",
): {
	readonly program: CoreProgram;
	readonly function: CoreFunctionId;
	readonly block: CoreBlockId;
	readonly first: CoreInstructionId;
	readonly finish: CoreInstructionId;
} {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[]],
	});
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const entry = builder.createBlock();
	const [left] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 2 },
		outputRepresentations: ["f64"],
	});
	const [right] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 3 },
		outputRepresentations: ["f64"],
	});
	const [product] = builder.appendInstruction(entry, "binary", [left!, right!], {
		attributes: { operator: startOperator },
	});
	const [sum] = builder.appendInstruction(entry, "binary", [product!, right!], {
		attributes: { operator: finishOperator },
	});
	builder.setTerminator(entry, { kind: "return", value: sum! });
	const { function: functionId } = builder.finish(entry);
	const [first, finish] = [
		...program.function(functionId).bodyInstructionIds(entry),
	].filter(
		(instruction) =>
			program.function(functionId).instructionOpcodeName(instruction) === "binary",
	);
	return {
		program,
		function: functionId,
		block: entry,
		first: first!,
		finish: finish!,
	};
}

function numericFanOutProgram(): {
	readonly program: CoreProgram;
	readonly function: CoreFunctionId;
} {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[]],
	});
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const entry = builder.createBlock();
	const [left] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 2 },
		outputRepresentations: ["f64"],
	});
	const [right] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 3 },
		outputRepresentations: ["f64"],
	});
	const [product] = builder.appendInstruction(entry, "binary", [left!, right!], {
		attributes: { operator: "*" },
		outputRepresentations: ["f64"],
	});
	const [sum] = builder.appendInstruction(entry, "binary", [product!, right!], {
		attributes: { operator: "+" },
		outputRepresentations: ["f64"],
	});
	builder.appendInstruction(entry, "binary", [product!, left!], {
		attributes: { operator: "-" },
		outputRepresentations: ["f64"],
	});
	builder.setTerminator(entry, { kind: "return", value: sum! });
	const { function: functionId } = builder.finish(entry);
	return { program, function: functionId };
}

function stackObjectProgram(
	mode: "elided" | "activation-local" | "materialized" | "identity",
): {
	readonly program: CoreProgram;
	readonly function: CoreFunctionId;
} {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[0x76, 0x61, 0x6c, 0x75, 0x65]],
	});
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const entry = builder.createBlock();
	const [initial] = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
		outputRepresentations: ["boolean"],
	});
	const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
		attributes: { keyStringIndices: [0] },
		outputRepresentations: ["boxed"],
	});
	if (mode === "identity") {
		const [value] = builder.appendInstruction(entry, "typeofCompare", [object!], {
			attributes: { expected: "object", negated: false },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, { kind: "return", value: value! });
	} else if (mode === "activation-local") {
		const [value] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 0 },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(entry, { kind: "return", value: value! });
	} else {
		builder.setTerminator(entry, {
			kind: "return",
			value: mode === "materialized" ? object! : initial!,
		});
	}
	const { function: functionId } = builder.finish(entry);
	return { program, function: functionId };
}

function directEntryProgram(): {
	readonly program: CoreProgram;
	readonly caller: CoreFunctionId;
	readonly callee: CoreFunctionId;
	readonly omittedCall: CoreInstructionId;
} {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[]],
	});
	const callerBuilder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const callerEntry = callerBuilder.createBlock();
	const [calleeValue] = callerBuilder.appendInstruction(
		callerEntry,
		"createFunction",
		[],
		{
			attributes: { functionIndex: 1 },
		},
	);
	const [receiver] = callerBuilder.appendInstruction(callerEntry, "createUndefined", []);
	const [result] = callerBuilder.appendInstruction(
		callerEntry,
		"call",
		[calleeValue!, receiver!],
		{
			attributes: {
				directFunctionIndex: 1,
			},
		},
	);
	callerBuilder.setTerminator(callerEntry, { kind: "return", value: result! });
	const omitted = callerBuilder.createBlock();
	const [omittedCallee] = callerBuilder.appendInstruction(omitted, "createFunction", [], {
		attributes: { functionIndex: 1 },
	});
	const [omittedReceiver] = callerBuilder.appendInstruction(
		omitted,
		"createUndefined",
		[],
	);
	const [omittedResult] = callerBuilder.appendInstruction(
		omitted,
		"call",
		[omittedCallee!, omittedReceiver!],
		{
			attributes: {
				directFunctionIndex: 1,
			},
		},
	);
	callerBuilder.setTerminator(omitted, {
		kind: "return",
		value: omittedResult!,
	});
	const { function: caller } = callerBuilder.finish(callerEntry);
	const omittedCall = [...program.function(caller).bodyInstructionIds(omitted)].find(
		(instruction) =>
			program.function(caller).instructionOpcodeName(instruction) === "call",
	)!;

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
	return { program, caller, callee, omittedCall };
}

function admissionIntervalProgram(interiorCall: boolean) {
	const program = new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[]],
	});
	const builder = new CoreFunctionBuilder(program, {
		metadata: { sourcePath: "/entry.js" },
	});
	const entry = builder.createBlock();
	const [callee] = builder.appendInstruction(entry, "createUndefined", []);
	const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
	builder.appendInstruction(entry, "call", [callee!, receiver!]);
	const [left] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 1 },
		outputRepresentations: ["f64"],
	});
	if (interiorCall) builder.appendInstruction(entry, "call", [callee!, receiver!]);
	const [right] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 2 },
		outputRepresentations: ["f64"],
	});
	const [sum] = builder.appendInstruction(entry, "binary", [left!, right!], {
		attributes: { operator: "+" },
		outputRepresentations: ["f64"],
	});
	builder.setTerminator(entry, { kind: "return", value: sum! });
	const { function: functionId } = builder.finish(entry);
	const fn = program.function(functionId);
	const instructions = [...fn.bodyInstructionIds(entry)];
	const anchor = instructions.find(
		(instruction) =>
			fn.instructionOpcodeName(instruction) === "createF64" &&
			fn.instructionAttributes(instruction).value === 1,
	)!;
	const use = instructions.find(
		(instruction) => fn.instructionOpcodeName(instruction) === "binary",
	)!;
	return { program, functionId, entry, anchor, use };
}

describe("late Core specialization plan", () => {
	it("keeps rich recipe projections out of production target lowering", () => {
		const source = readFileSync("src/compiler/target/lower-execution.ts", "utf8");

		expect(source).not.toMatch(/CorePlanSpecialization|projectCoreSpecialization/u);
		expect(source).not.toMatch(
			/from "\.\.\/core\/core-(?:cross-call-transforms|ir-(?:provenance|shape-provenance|value-classes|value-kinds))\.ts"/u,
		);
		expect(source).toMatch(/from "\.\.\/core\/core-internal-attributes\.ts"/u);
		expect(source).toMatch(/coreSpecializationRecipeKindAt/u);
		expect(source).toMatch(/coreSpecializationRecipePayloadAt/u);
	});

	it("plans direct split regions from the canonical callBuiltin producer", () => {
		for (const [kind, source] of [
			[
				"string-split-projection",
				`function first() { return "alpha,beta".split(",")[0]; }
				globalThis.first = first;`,
			],
			[
				"string-split-cursor",
				`function sum(separator) {
					const parts = " alpha ; beta ".split(separator);
					let total = 0;
					for (let index = 0; index < parts.length; index++) {
						total += parts[index].trim().length;
					}
					return total;
				}
				globalThis.sum = sum;`,
			],
		] as const) {
			const semantic = analyzeSourceAndRunSemanticAnalysis(
				source,
				`direct-${kind}.js`,
				parseScript(source, { strict: false }),
			);
			const compilation = optimizeSemanticProgramToCore(
				semantic,
				{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
				(_phase, run) => run(),
			);
			const selection = planSpecializations(compilation.plan).find(
				(candidate) => candidate.kind === kind,
			);
			expect(selection).toBeDefined();
			if (
				selection?.kind !== "string-split-projection" &&
				selection?.kind !== "string-split-cursor"
			)
				throw new Error(`missing ${kind} plan`);
			const split =
				selection.kind === "string-split-projection"
					? selection.stringSplitProjection
					: selection.stringSplitCursor;
			expect(split.property).toBeUndefined();
			expect(selection.admission.anchor).toBe(split.call);
			expect(selection.claimedInstructions).toContain(split.call);
			expect(
				compilation.program
					.function(selection.function)
					.instructionOpcodeName(split.call),
			).toBe("callBuiltin");
		}
	});

	it("keeps compact recipe storage immutable across diagnostic projections", () => {
		const source = `globalThis.first = function first(value) {
			const fields = value.split(";");
			return fields[0];
		};`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"certified-plan-freeze.js",
			parseScript(source, { strict: false }),
		);
		let callbackPlan: CoreOptimizationPlan | undefined;
		let originalIndex: number | undefined;
		const compilation = optimizeSemanticProgramToCore(
			semantic,
			{
				afterCoreOptimization(_program, _context, _report, plan) {
					callbackPlan = plan;
					const selection = planSpecializations(plan).find(
						(candidate) => candidate.kind === "string-split-projection",
					);
					if (selection?.kind !== "string-split-projection") {
						throw new Error("missing split projection plan");
					}
					const load = selection.stringSplitProjection.loads[0]! as {
						index?: number;
					};
					originalIndex = load.index;
					load.index = 99;
				},
			},
			(_phase, run) => run(),
		);
		expect(callbackPlan).toBe(compilation.plan);
		expect(Object.isFrozen(compilation.plan.recipes)).toBe(true);
		expect(Object.keys(compilation.plan.recipes)).toEqual(["count"]);
		const selection = planSpecializations(compilation.plan).find(
			(candidate) => candidate.kind === "string-split-projection",
		);
		if (selection?.kind !== "string-split-projection") {
			throw new Error("missing split projection plan");
		}
		expect((selection.stringSplitProjection.loads[0] as { index?: number }).index).toBe(
			originalIndex,
		);
		expect(() => lowerCoreCompilationToExecution(compilation)).not.toThrow();
	});

	it("bounds stable admission to code between the anchor and licensed use", () => {
		for (const [interiorCall, expected] of [
			[false, "stable"],
			[true, "per-use"],
		] as const) {
			const { program, functionId, entry, anchor, use } =
				admissionIntervalProgram(interiorCall);
			expect(
				corePlanAdmissionMode(
					program.function(functionId),
					buildCoreControlFlow(program, functionId),
					{
						anchor,
						dependencies: [{ kind: "epoch", family: "watched-methods" }],
						claimedInstructions: [anchor, use],
						ordinaryBlocks: [entry],
						exceptionalBlocks: [],
					},
				),
			).toBe(expected);
		}
	});

	it("selects deterministically and charges the shared code/work budgets", () => {
		const { program, function: functionId } = numericProgram();
		const first = planning(program, [functionId]);
		const second = buildCoreOptimizationPlan(program, first.analyses, first.summaries, [
			functionId,
		]);
		expect(second).toEqual(first.plan);
		expect(planSpecializations(second)).toEqual(planSpecializations(first.plan));
		const selected = planSpecializations(first.plan);
		expect(selected).toHaveLength(1);
		expect(selected[0]).toMatchObject({
			kind: "numeric-fusion",
			function: functionId,
			fallback: "canonical-core",
			composition: "overlay",
		});
		expect(first.plan.statistics.generatedCodeConsumed).toBeGreaterThan(0);
		expect(first.plan.statistics.compilerWorkConsumed).toBeGreaterThan(0);
		const storage = coreSpecializationRecipeStorageStatistics(first.plan.recipes);
		expect(storage.recipes).toBe(1);
		expect(storage.payloadCells).toBeGreaterThan(0);
		expect(storage.numericBytes).toBeGreaterThan(0);

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
		expect(planSpecializations(declined)).toEqual([]);
		expect(declined.statistics.declinedByPlanReason["generated-code-cost"]).toBe(1);
	});

	it("reports local discovery from the planner's single query", () => {
		const { program, function: functionId } = numericProgram();
		const first = planning(program, [functionId]);
		let functions = 0;
		let candidates = 0;
		buildCoreOptimizationPlan(program, first.analyses, first.summaries, [functionId], {
			onLocalCandidates(_functionId, discovered) {
				functions++;
				candidates += discovered.length;
			},
		});

		expect(functions).toBe(1);
		expect(candidates).toBeGreaterThan(0);
	});

	it("reuses current local planning inputs and rebuilds stale ones", () => {
		const { program, function: functionId } = numericProgram();
		const prepared = planning(program, [functionId]);
		const input = buildCoreLocalOptimizationPlanInput(
			program,
			prepared.analyses,
			coreLocalSpecializationFeatureIndex(program),
			functionId,
			prepared.context,
		);
		const currentReport = new CoreOptimizationReportBuilder(program, "full");
		const current = buildCoreOptimizationPlan(
			program,
			new CoreAnalysisManager(program, prepared.context, currentReport),
			prepared.summaries,
			[functionId],
			{ context: prepared.context, localInputs: [input] },
		);

		expect(current).toEqual(prepared.plan);
		expect(currentReport.finish(program, current).analyses).toEqual([]);

		const editor = CoreEditor.open(program, functionId);
		const unreachable = editor.createBlock();
		editor.setTerminator(unreachable, { kind: "unreachable" });
		editor.commit();
		const staleReport = new CoreOptimizationReportBuilder(program, "full");
		const stale = buildCoreOptimizationPlan(
			program,
			new CoreAnalysisManager(program, prepared.context, staleReport),
			prepared.summaries,
			[functionId],
			{ context: prepared.context, localInputs: [input] },
		);

		expect(stale.blockOrders[0]?.omittedBlocks).toContain(unreachable);
		expect(staleReport.finish(program, stale).analyses.length).toBeGreaterThan(0);
	});

	it("rejects numeric fusion when the intermediate has multiple uses", () => {
		const { program, function: functionId } = numericFanOutProgram();
		const { plan } = planning(program, [functionId]);

		expect(plan.statistics.discoveredByKind["numeric-fusion"]).toBeUndefined();
		expect(planSpecializations(plan)).toEqual([]);
	});

	it("seals stack-object elision, direct slots, and return materialization", () => {
		for (const [sourceMode, expectedMode, materializations] of [
			["elided", "elided", 0],
			["activation-local", "activation-local", 0],
			["materialized", "activation-local", 1],
			["identity", "activation-local", 0],
		] as const) {
			const { program, function: functionId } = stackObjectProgram(sourceMode);
			const { context, plan } = planning(program, [functionId]);
			const selection = planSpecializations(plan)[0];
			expect(selection).toMatchObject({
				kind: "stack-object-plan",
				representation: "activation-local-fixed-shape-objects",
				fallback: "canonical-core",
				stackObject: {
					mode: expectedMode,
					slotCount: 1,
				},
			});
			const sealed = program.seal();
			const execution = lowerCoreCompilationToExecution({
				program: sealed,
				context,
				plan: verifyCoreOptimizationPlan(sealed, plan),
			});
			const image = deserializeCompilerArtifact(
				serializeCompilerArtifact(lowerExecutionToProgramImage(execution)),
			);
			const region = image.native.functions[0]!.specializations.find(
				({ kind }) => kind === "stack-object-plan",
			);
			if (region?.kind !== "stack-object-plan") throw new Error("Expected stack plan");
			expect(region.sites[0]!.mode).toBe(expectedMode);
			if (selection?.kind !== "stack-object-plan") {
				throw new Error("expected stack-object plan");
			}
			expect(selection.stackObject.materializations).toHaveLength(materializations);
			const invalid = withPlanSpecializations(plan, [
				{
					...selection,
					stackObject: {
						...selection.stackObject,
						slotCount: selection.stackObject.slotCount + 1,
					},
				},
			]);
			expect(() => verifyCoreOptimizationPlan(sealed, invalid)).toThrow(
				/invalid stack-object certificate/,
			);
		}
	});

	it("rejects numeric operators outside the native fusion contract", () => {
		for (const [startOperator, finishOperator, message] of [
			["**", "+", /supported generic binary operation/],
			["*", "in", /invalid numeric-fusion continuation/],
		] as const) {
			const {
				program,
				function: functionId,
				block,
				first,
				finish,
			} = numericProgram(startOperator, finishOperator);
			const { plan } = planning(program, [functionId]);
			expect(planSpecializations(plan)).toEqual([]);
			const invalid = withPlanSpecializations(plan, [
				{
					id: `numeric-fusion:${functionId}:${first}:${finish}`,
					kind: "numeric-fusion",
					function: functionId,
					anchors: [first],
					claimedInstructions: [first, finish],
					ordinaryBlocks: [block],
					exceptionalBlocks: [],
					representation: "binary-pairs-f64",
					requiredRepresentations: [],
					target: "native",
					fallback: "canonical-core",
					semanticProtectors: [],
					targetFunctions: [],
					admission: { anchor: first, mode: "stable" },
					composition: "overlay",
					cost: { generatedCode: 0, compilerWork: 0, runtimeBenefit: 0 },
				},
			]);
			expect(() => verifyCoreOptimizationPlan(program.seal(), invalid)).toThrow(message);
		}
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
		const selected = planSpecializations(plan)[0]!;
		const conflict = withPlanSpecializations(plan, [
			selected,
			{ ...selected, id: `${selected.id}:duplicate` },
		]);
		expect(() => verifyCoreOptimizationPlan(sealed, conflict)).toThrow(/conflicts/);
	});

	it("requires an optimizer-issued certificate at the target boundary", () => {
		const { program, function: functionId } = numericProgram();
		const { context, plan } = planning(program, [functionId]);
		const sealed = program.seal();
		expect(() =>
			lowerCoreCompilationToExecution({
				program: sealed,
				context,
				plan: plan as VerifiedCoreOptimizationPlan,
			}),
		).toThrow(/requires the optimizer's verified plan certificate/);
		expect(() =>
			lowerCoreCompilationToExecution({
				program: sealed,
				context,
				plan: verifyCoreOptimizationPlan(sealed, plan),
			}),
		).not.toThrow();
	});

	it("seals String projection proof payloads and rejects claimed mutation", () => {
		const { program, function: functionId, call } = stringSplitProgram();
		const { context, plan } = planning(program, [functionId]);
		const selection = planSpecializations(plan).find(
			(candidate) => candidate.kind === "string-split-projection",
		);
		if (selection?.kind !== "string-split-projection") {
			throw new Error("expected String.split projection plan");
		}
		expect(selection).toMatchObject({
			fallback: "canonical-core",
			representation: "projected-elements",
			admission: {
				anchor: selection.stringSplitProjection.property,
				mode: "per-use",
			},
			stringSplitProjection: {
				call,
				splitIdentity: "runtime-guarded",
				builtinCall: { operation: "String.prototype.split" },
			},
		});
		expect(program.function(functionId).instructionAttributes(call)).not.toHaveProperty(
			"knownBuiltinCall",
		);
		const sealed = program.seal();
		expect(() => verifyCoreOptimizationPlan(sealed, plan)).not.toThrow();
		const execution = lowerCoreCompilationToExecution({
			program: sealed,
			context,
			plan: verifyCoreOptimizationPlan(sealed, plan),
		});
		const loweredCall = execution.functions[functionId]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ type }) => type === "call");
		expect(loweredCall).toMatchObject({
			type: "call",
			knownBuiltinCall: { operation: "String.prototype.split" },
		});

		const invalid = withPlanSpecializations(plan, [
			{
				...selection,
				stringSplitProjection: {
					...selection.stringSplitProjection,
					separatorStringIndex: selection.stringSplitProjection.separatorStringIndex + 1,
				},
			},
		]);
		expect(() => verifyCoreOptimizationPlan(sealed, invalid)).toThrow(
			/invalid String\.split projection certificate/,
		);
		const invalidAdmission = withPlanSpecializations(plan, [
			{
				...selection,
				admission: { ...selection.admission, mode: "stable" },
			},
		]);
		expect(() => verifyCoreOptimizationPlan(sealed, invalidAdmission)).toThrow(
			/claims stable admission where Core proves per-use/,
		);
	});

	it("verifies and relocates a numeric plan without changing generic Core", () => {
		const { program, function: functionId } = numericProgram();
		const { context, plan } = planning(program, [functionId]);
		const selection = planSpecializations(plan)[0]!;
		const anchorOpcode = program
			.function(functionId)
			.instructionOpcodeName(selection.anchors[0]!);
		const sealed = program.seal();
		const execution = lowerCoreCompilationToExecution({
			program: sealed,
			context,
			plan: verifyCoreOptimizationPlan(sealed, plan),
		});
		expect(() => lowerExecutionToProgramImage(execution)).not.toThrow();

		expect(execution.functions[0]!.specializations).toMatchObject([
			{
				kind: "numeric-fusion",
				representation: "binary-pairs-f64",
				composition: "overlay",
				runtimeGuard: "number-operands",
			},
		]);
		expect(
			program.function(functionId).instructionOpcodeName(selection.anchors[0]!),
		).toBe(anchorOpcode);

		const invalid = withPlanSpecializations(plan, [
			{
				...selection,
				claimedInstructions: [selection.anchors[0]!],
			},
		]);
		expect(() => verifyCoreOptimizationPlan(sealed, invalid)).toThrow(
			/invalid numeric-fusion certificate/,
		);
	});

	it("requires exact exceptional-CFG reachability in the lowering order", () => {
		const { program, function: functionId } = numericProgram();
		const { plan } = planning(program, [functionId]);
		const sealed = program.seal();
		const order = plan.blockOrders[0]!;
		const invalid: CoreOptimizationPlan = {
			...plan,
			blockOrders: [
				{
					function: functionId,
					blocks: [],
					omittedBlocks: order.blocks,
				},
			],
		};
		expect(() => verifyCoreOptimizationPlan(sealed, invalid)).toThrow(
			/block lowering order/,
		);
	});

	it("preserves more than forty selected specializations through lowering and artifacts", () => {
		const program = new CoreProgram(coreOpcodeRegistry, {
			stringConstants: [[0x76, 0x61, 0x6c, 0x75, 0x65]],
		});
		const builder = new CoreFunctionBuilder(program, {
			metadata: { sourcePath: "/entry.js" },
		});
		const entry = builder.createBlock();
		let result;
		for (let index = 0; index < 41; index++) {
			const [value] = builder.appendInstruction(entry, "createBoolean", [], {
				attributes: { value: index % 2 === 0 },
				outputRepresentations: ["boolean"],
			});
			builder.appendInstruction(entry, "createObjectShaped", [value!], {
				attributes: { keyStringIndices: [0] },
			});
			result = value;
		}
		if (result === undefined) throw new Error("test program has no result");
		builder.setTerminator(entry, { kind: "return", value: result });
		const { function: functionId } = builder.finish(entry);
		const prepared = planning(program, [functionId]);
		const plan = buildCoreOptimizationPlan(
			program,
			prepared.analyses,
			prepared.summaries,
			[functionId],
			{
				context: prepared.context,
				budgets: {
					perSiteExpansions: 1,
					perCallerExpansions: 1_000,
					perCallerGeneratedCode: 100_000,
					perCallerCompilerWork: 100_000,
					programGeneratedCode: 100_000,
					programCompilerWork: 100_000,
				},
			},
		);
		expect(
			planSpecializations(plan).filter(({ kind }) => kind === "stack-object-plan"),
		).toHaveLength(41);
		const sealed = program.seal();
		const definition = lowerExecutionToProgramImage(
			lowerCoreCompilationToExecution({
				program: sealed,
				context: prepared.context,
				plan: verifyCoreOptimizationPlan(sealed, plan),
			}),
		);
		expect(
			definition.native.functions.flatMap(({ specializations }) => specializations),
		).toHaveLength(41);
		expect(
			deserializeCompilerArtifact(
				serializeCompilerArtifact(definition),
			).native.functions.flatMap(({ specializations }) => specializations),
		).toEqual(
			definition.native.functions.flatMap(({ specializations }) => specializations),
		);
	});

	it("relocates direct entries into native execution while retaining generic Core", () => {
		const { program, caller, callee, omittedCall } = directEntryProgram();
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
		expect(plan.statistics.admittedFunctions).toBe(2);
		const coreCall = plan.directEntries[0]!.callSites[0]!;
		expect(
			program.function(caller).instructionAttributes(coreCall.instruction),
		).not.toHaveProperty("directEntryId");
		const sealed = program.seal();
		const execution = lowerCoreCompilationToExecution({
			program: sealed,
			context,
			plan: verifyCoreOptimizationPlan(sealed, plan),
		});
		expect(execution.functions[callee]!.directEntries).toMatchObject([
			{ id: 0, resultRepresentation: "number" },
		]);
		const loweredCall = execution.functions[caller]!.blocks.flatMap(
			({ instructions }) => instructions,
		).find(({ type }) => type === "call");
		expect(loweredCall).toMatchObject({
			type: "call",
			directFunctionIndex: callee,
			directEntryId: 0,
		});

		const genericOnly: CoreOptimizationPlan = {
			...plan,
			directEntries: [],
			recipes: buildCoreSpecializationRecipeTable([]),
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
			plan: verifyCoreOptimizationPlan(sealed, genericOnly),
		});
		expect(
			generic.functions[caller]!.blocks.flatMap(({ instructions }) => instructions).find(
				({ type }) => type === "call",
			),
		).not.toHaveProperty("directFunctionIndex");
		expect(generic.functions.every((fn) => fn.directEntries.length === 0)).toBe(true);

		const omittedCallsite: CoreOptimizationPlan = {
			...plan,
			directEntries: [
				{
					...plan.directEntries[0]!,
					callSites: [
						...plan.directEntries[0]!.callSites,
						{ caller, instruction: omittedCall },
					],
				},
			],
		};
		expect(() => verifyCoreOptimizationPlan(sealed, omittedCallsite)).toThrow(
			/omitted from target lowering/,
		);
	});

	it("keeps direct-entry call sites scoped to their caller function", () => {
		const definition = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`if (!((function () {
					const nested = function () { return typeof this; };
					return nested() === "undefined" && typeof this === "undefined";
				})())) throw new Error("unexpected this value");`,
				"direct-entry-function-local-site.js",
			),
		);
		const directTargets = definition.runtime.functions.flatMap((fn) =>
			fn.instructions.flatMap((instruction) =>
				instruction.opcode === "CALL" && instruction.exactFunctionIndex !== undefined
					? [instruction.exactFunctionIndex]
					: [],
			),
		);

		expect(directTargets).toEqual([1, 2]);
	});

	it("keeps functions that enumerate the argument slice on the canonical ABI", () => {
		let directEntryCount = -1;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function observesArguments() { return Object.keys(arguments).length === 0; }
				observesArguments();`,
				"direct-entry-arguments.js",
			),
			{
				afterCoreOptimization(_program, _context, _report, plan) {
					directEntryCount = plan.directEntries.length;
				},
			},
		);

		expect(directEntryCount).toBe(0);
	});

	it("specializes the real object benchmark's four-argument observation", () => {
		const definition = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				readFileSync("bench/javascript.mjs", "utf8"),
				"argument-edges-benchmark.js",
			),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
		);
		const boundedLoads = definition.native.functions.flatMap((fn, index) =>
			fn.instructions.flatMap((access, ip) => {
				const instruction = definition.runtime.functions[index]!.instructions[ip]!;
				return access?.kind === "contained-fixed-typed-array-element" &&
					access.inBounds &&
					instruction.opcode === "LOAD_PROPERTY"
					? [fn.registerRepresentations[instruction.dst]]
					: [];
			}),
		);
		expect(boundedLoads).toEqual(["number", "number"]);
		const histogramIndex = definition.native.functions.findIndex((fn) =>
			fn.instructions.some(
				(access) =>
					access?.kind === "contained-fixed-typed-array-element" && access.inBounds,
			),
		);
		const histogramSource = emitCompiledFunction(
			definition.runtime.functions[histogramIndex]!,
			definition.native.functions[histogramIndex]!,
			histogramIndex,
			"",
			false,
		)!.source;
		expect(histogramSource).toContain("mal_scalar_store_native_u32");
		expect(histogramSource).not.toContain("mal_vm_typed_array_numeric_index");
		const integerSites = definition.native.functions.flatMap((fn) =>
			fn.instructions.filter(
				(instruction) => instruction?.kind === "unsigned-arithmetic",
			),
		);
		expect(integerSites.length).toBeGreaterThan(0);
		expect(
			deserializeCompilerArtifact(
				serializeCompilerArtifact(definition),
			).native.functions.flatMap((fn) =>
				fn.instructions.filter(
					(instruction) => instruction?.kind === "unsigned-arithmetic",
				),
			),
		).toEqual(integerSites);
		const index = definition.runtime.functions.findIndex((fn) =>
			fn.instructions.some(
				(instruction) =>
					instruction.opcode === "LOAD_STATIC_ARGUMENT" && instruction.index === 3,
			),
		);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(definition.native.functions[index]!.directEntries).toMatchObject([
			{
				argumentRepresentations: ["number", "number", "number", "number"],
				resultRepresentation: "number",
			},
		]);
		const emitted = emitCompiledFunction(
			definition.runtime.functions[index]!,
			definition.native.functions[index]!,
			index,
			"",
			false,
		);
		expect(emitted?.directEntries).toHaveLength(1);
		expect(emitted!.directEntries[0]!.source).not.toMatch(
			/arg_count|mal_create_arguments_object|mal_vm_binary_op/,
		);
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(definition)).native.functions[
				index
			]!.directEntries,
		).toEqual(definition.native.functions[index]!.directEntries);
	});

	it("specializes numeric arguments despite a mixed canonical return", () => {
		const definition = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`
				(function () {
					const add = function (left, right) { let result = left; for (let index = 0; index < 16; index++) result = result + right; return result; };
					const external = [add];
					globalThis.result = add(3, 7);
					globalThis.mixed = external[0]("left", "right");
				})();`,
				"typed-entry.js",
			),
		);
		const index = definition.native.functions.findIndex((fn) =>
			fn.directEntries.some(
				(entry) => entry.parameterRepresentations.join(",") === "number,number",
			),
		);
		expect(index).toBeGreaterThanOrEqual(0);
		const fn = definition.native.functions[index]!;
		expect(fn.registerRepresentations.slice(0, 2)).toEqual(["boxed", "boxed"]);
		expect(fn.directEntries[0]!.resultRepresentation).toBe("number");
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(definition)).native.functions[
				index
			]!.directEntries,
		).toEqual(fn.directEntries);
	});

	it.each([false, true])(
		"prefers the numeric loop signature over cold strings: nested=%s",
		(nested) => {
			const definition = compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`
				(function () {
					const helper = function (value) { let sum = value; for (let j = 0; j < 3; j++) sum = sum + value; return sum; };
					globalThis.coldA = helper("startup");
					globalThis.coldB = helper("shutdown");
					for (let i = 0; i < 10; i++) {
						${nested ? 'globalThis.outer = helper("outer"); for (let k = 0; k < 10; k++) {' : ""}
						globalThis.hot = helper(i + 0.5);
						${nested ? "}" : ""}
					}
				})();
			`,
					"loop-signature.js",
				),
			);
			const entries = definition.native.functions.flatMap((fn) => fn.directEntries);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.parameterRepresentations).toEqual(["number"]);
			expect(entries[0]!.resultRepresentation).toBe("number");
			const calls = definition.native.functions.flatMap((fn) =>
				fn.instructions.filter(
					(instruction) =>
						instruction?.kind === "call" && instruction.directEntryId !== undefined,
				),
			);
			expect(calls).toHaveLength(1);
		},
	);
});
