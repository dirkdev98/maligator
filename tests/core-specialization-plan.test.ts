import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { buildCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-selection.ts";
import {
	corePlanAdmissionMode,
	verifyCoreOptimizationPlan,
} from "../src/compiler/core/core-ir-region-validity.ts";
import type {
	CoreOptimizationPlan,
	VerifiedCoreOptimizationPlan,
} from "../src/compiler/core/core-ir-regions.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../src/compiler/core/core-ir-summaries.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
} from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
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
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
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
	return { program, function: functionId, block: entry, first: first!, finish: finish! };
}

function numericFanOutProgram(): {
	readonly program: CoreProgram;
	readonly function: CoreFunctionId;
} {
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
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

function stackObjectProgram(mode: "elided" | "activation-local" | "materialized"): {
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
	if (mode === "activation-local") {
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
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
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
				calleeTargets: { functions: [1], anyScript: false, opaque: false },
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
				calleeTargets: { functions: [1], anyScript: false, opaque: false },
			},
		},
	);
	callerBuilder.setTerminator(omitted, { kind: "return", value: omittedResult! });
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
	const program = new CoreProgram(coreOpcodeRegistry, { stringConstants: [[]] });
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
	it("deep-freezes the certified callback plan before target lowering", () => {
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
		let mutationError: unknown;
		const compilation = optimizeSemanticProgramToCore(
			semantic,
			{
				afterCoreOptimization(_program, _context, _report, plan) {
					callbackPlan = plan;
					const selection = plan.specializations.find(
						(candidate) => candidate.kind === "string-split-projection",
					);
					if (selection?.kind !== "string-split-projection") {
						throw new Error("missing split projection plan");
					}
					const load = selection.stringSplitProjection.loads[0]!;
					try {
						(load as { index?: number }).index = 99;
					} catch (error) {
						mutationError = error;
					}
				},
			},
			(_phase, run) => run(),
		);
		expect(callbackPlan).toBe(compilation.plan);
		expect(mutationError).toBeInstanceOf(TypeError);
		const selection = compilation.plan.specializations.find(
			(candidate) => candidate.kind === "string-split-projection",
		);
		if (selection?.kind !== "string-split-projection") {
			throw new Error("missing split projection plan");
		}
		expect(Object.isFrozen(selection.stringSplitProjection.loads[0])).toBe(true);
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

	it("rejects numeric fusion when the intermediate has multiple uses", () => {
		const { program, function: functionId } = numericFanOutProgram();
		const { plan } = planning(program, [functionId]);

		expect(plan.statistics.discoveredByKind["numeric-fusion"]).toBeUndefined();
		expect(plan.specializations).toEqual([]);
	});

	it("seals stack-object elision, direct slots, and return materialization", () => {
		for (const [sourceMode, expectedMode, materializations] of [
			["elided", "elided", 0],
			["activation-local", "activation-local", 0],
			["materialized", "activation-local", 1],
		] as const) {
			const { program, function: functionId } = stackObjectProgram(sourceMode);
			const { context, plan } = planning(program, [functionId]);
			const selection = plan.specializations[0];
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
			expect(() => lowerExecutionToProgramImage(execution)).not.toThrow();
			if (selection?.kind !== "stack-object-plan") {
				throw new Error("expected stack-object plan");
			}
			expect(selection.stackObject.materializations).toHaveLength(materializations);
			const invalid: CoreOptimizationPlan = {
				...plan,
				specializations: [
					{
						...selection,
						stackObject: {
							...selection.stackObject,
							slotCount: selection.stackObject.slotCount + 1,
						},
					},
				],
			};
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
			expect(plan.specializations).toEqual([]);
			const invalid: CoreOptimizationPlan = {
				...plan,
				specializations: [
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
				],
			};
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
		const selected = plan.specializations[0]!;
		const conflict: CoreOptimizationPlan = {
			...plan,
			specializations: [selected, { ...selected, id: `${selected.id}:duplicate` }],
		};
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
		const selection = plan.specializations.find(
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

		const invalid: CoreOptimizationPlan = {
			...plan,
			specializations: [
				{
					...selection,
					stringSplitProjection: {
						...selection.stringSplitProjection,
						separatorStringIndex:
							selection.stringSplitProjection.separatorStringIndex + 1,
					},
				},
			],
		};
		expect(() => verifyCoreOptimizationPlan(sealed, invalid)).toThrow(
			/invalid String\.split projection certificate/,
		);
		const invalidAdmission: CoreOptimizationPlan = {
			...plan,
			specializations: [
				{
					...selection,
					admission: { ...selection.admission, mode: "stable" },
				},
			],
		};
		expect(() => verifyCoreOptimizationPlan(sealed, invalidAdmission)).toThrow(
			/claims stable admission where Core proves per-use/,
		);
	});

	it("verifies and relocates a numeric plan without changing generic Core", () => {
		const { program, function: functionId } = numericProgram();
		const { context, plan } = planning(program, [functionId]);
		const selection = plan.specializations[0]!;
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

		const invalid: CoreOptimizationPlan = {
			...plan,
			specializations: [
				{
					...selection,
					claimedInstructions: [selection.anchors[0]!],
				},
			],
		};
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
		builder.setTerminator(entry, { kind: "return", value: result! });
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
			plan.specializations.filter(({ kind }) => kind === "stack-object-plan"),
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
});
