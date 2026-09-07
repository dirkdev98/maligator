import { describe, expect, it } from "vitest";
import { CoreAnalysisManager } from "../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	buildCoreControlFlow,
} from "../src/compiler/core/core-ir-control-flow.ts";
import {
	CORE_FACT_AVAILABILITY_ANALYSIS,
	analyzeCoreFactAvailability,
} from "../src/compiler/core/core-ir-fact-implication.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_LOCAL_VALUE_KIND_ANALYSIS,
	analyzeCoreValueKinds,
} from "../src/compiler/core/core-ir-value-kinds.ts";
import { CORE_NO_EFFECTS } from "../src/compiler/core/core-ir.ts";
import { CoreOptimizationReportBuilder } from "../src/compiler/core/core-optimization-report.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { CORE_PROOF_PASSES } from "../src/compiler/core/core-proof-passes.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";
import { coreFunctionNamed } from "./helpers/core-inspection.ts";

const context: CoreCompilationContext = {
	facts: conservativeCompilerProgramFacts(),
	data: {
		entrypointPath: "proof-passes.js",
		moduleEvaluationOrder: ["proof-passes.js"],
		sourceFiles: [{ path: "proof-passes.js", contents: "" }],
		cjsModuleFunctionIndices: [],
		hostInstallCandidates: [],
		singleAssignmentGlobalSlots: [],
		singleAssignmentCapturedSlots: [],
		retainedHostInstallers: [],
	},
};

describe("Core local proofs and representations", () => {
	it.each(["-", "+", "~", "increment", "decrement", "tonumeric"])(
		"infers %s independently of block order through forward dependencies and loop joins",
		(operator) => {
			for (const consumerFirst of [false, true]) {
				for (const unknown of [false, true]) {
					const program = new CoreProgram(coreOpcodeRegistry);
					const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
					const entry = builder.createBlock([{ representation: "boxed" }]);
					const input = inspectCoreBlockParameters(builder, entry)[0]!.value;
					const first = builder.createBlock([{ representation: "boxed" }]);
					const second = builder.createBlock([{ representation: "boxed" }]);
					const producer = consumerFirst ? second : first;
					const consumer = consumerFirst ? first : second;
					const exit = builder.createBlock();
					const [constant] = builder.appendInstruction(entry, "createNumber", [], {
						attributes: { value: 3 },
					});
					builder.setTerminator(entry, {
						kind: "jump",
						edge: { block: producer, arguments: [unknown ? input : constant!] },
					});
					const initial = inspectCoreBlockParameters(builder, producer)[0]!.value;
					const joined = inspectCoreBlockParameters(builder, consumer)[0]!.value;
					const [seed] = builder.appendInstruction(producer, "unary", [initial], {
						attributes: { operator },
					});
					builder.setTerminator(producer, {
						kind: "jump",
						edge: { block: consumer, arguments: [seed!] },
					});
					const [updated] = builder.appendInstruction(consumer, "unary", [joined], {
						attributes: { operator },
					});
					const [scaled] = builder.appendInstruction(
						consumer,
						"binary",
						[updated!, constant!],
						{ attributes: { operator: "*" } },
					);
					builder.setTerminator(consumer, {
						kind: "branch",
						condition: input,
						consequent: { block: consumer, arguments: [scaled!] },
						alternate: { block: exit, arguments: [] },
					});
					builder.setTerminator(exit, { kind: "return", value: scaled! });
					const finished = builder.finish(entry);
					const kinds = analyzeCoreValueKinds(
						program.function(finished.function),
						buildCoreControlFlow(program, finished.function),
					);
					for (const value of [seed!, joined, updated!, scaled!]) {
						expect(kinds.latticeMask(value)).toBe(
							unknown ? COMPILER_VALUE_KIND_TOP : COMPILER_VALUE_KIND_NUMBER,
						);
					}
				}
			}
		},
	);

	it.each([
		{ closed: false, stores: 1, expected: COMPILER_VALUE_KIND_TOP },
		{ closed: true, stores: 0, expected: COMPILER_VALUE_KIND_TOP },
		{ closed: true, stores: 1, expected: COMPILER_VALUE_KIND_NUMBER },
		{ closed: true, stores: 2, expected: COMPILER_VALUE_KIND_TOP },
	])(
		"uses a global kind only after one dominating closed store: closed=$closed stores=$stores",
		({ closed, stores, expected }) => {
			const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock();
			const [before] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			const [value] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 42 },
			});
			for (let index = 0; index < stores; index++)
				builder.appendInstruction(entry, "storeGlobal", [value!], {
					attributes: { index: 0 },
				});
			const [after] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(entry, { kind: "return", value: after! });
			const finished = builder.finish(entry);
			const analysisContext = {
				...context,
				data: { ...context.data, singleAssignmentGlobalSlots: closed ? [0] : [] },
			};
			const analyses = new CoreAnalysisManager(
				program,
				analysisContext,
				new CoreOptimizationReportBuilder(program),
			);
			const kinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
				scope: "function",
				function: finished.function,
			});
			expect(kinds.kindMask(before!)).toBe(COMPILER_VALUE_KIND_TOP);
			expect(kinds.kindMask(after!)).toBe(expected);
		},
	);

	it("makes a guard fact available only where its success edge dominates", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([
			{ representation: "boolean" },
			{ representation: "boxed" },
		]);
		const success = builder.createBlock();
		const fallback = builder.createBlock();
		const merge = builder.createBlock();
		const [condition, subject] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const fact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: success, arguments: [] },
			fallback: { block: fallback, arguments: [] },
			fact: {
				kind: "identity-test",
				value: "number",
				claims: [{ kind: "identity", subject: subject!, identities: [1] }],
				origin: "test",
			},
		});
		builder.setTerminator(success, {
			kind: "jump",
			edge: { block: merge, arguments: [] },
		});
		builder.setTerminator(fallback, {
			kind: "jump",
			edge: { block: merge, arguments: [] },
		});
		builder.setTerminator(merge, { kind: "return", value: subject! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const availability = analyzeCoreFactAvailability(
			fn,
			buildCoreControlFlow(program, finished.function),
		);
		expect(availability.availableAtBlock(success)).toContain(fact);
		expect(availability.availableAtBlock(fallback)).not.toContain(fact);
		expect(availability.availableAtBlock(merge)).not.toContain(fact);
	});

	it("solves exact local kinds with a bounded value worklist", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [sum] = builder.appendInstruction(entry, "binary", [one!, two!], {
			attributes: { operator: "+" },
		});
		const [comparison] = builder.appendInstruction(entry, "binary", [sum!, two!], {
			attributes: { operator: ">" },
		});
		builder.setTerminator(entry, { kind: "return", value: comparison! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const kinds = analyzeCoreValueKinds(
			fn,
			buildCoreControlFlow(program, finished.function),
		);
		expect(kinds.kindMask(sum!)).toBe(COMPILER_VALUE_KIND_NUMBER);
		expect(kinds.kindMask(comparison!)).toBe(COMPILER_VALUE_KIND_BOOLEAN);
		expect(kinds.exactScalar(one!)).toBe("int32");
		expect(kinds.exactScalar(sum!)).toBe("number");
	});

	it("materializes primitive effects with stable proof references and scalar representations", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [one] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [two] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [sum] = builder.appendInstruction(entry, "binary", [one!, two!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(entry, { kind: "return", value: sum! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const sumDefinition = inspectCoreValueDefinition(fn, sum!);
		if (sumDefinition.kind !== "instruction")
			throw new Error("Expected instruction result");
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		new CoreFunctionPassScheduler(
			program,
			context,
			analyses,
			report,
			finished.function,
		).runComponent("proofs", CORE_PROOF_PASSES);
		const refinement = fn.instructionEffectRefinement(sumDefinition.instruction);
		expect(refinement).toBeDefined();
		expect(fn.fact(refinement!.proof)).toMatchObject({
			id: refinement!.proof,
			kind: "primitive-operator-effects",
			claims: [{ kind: "effect", instruction: sumDefinition.instruction }],
		});
		expect(fn.valueRepresentation(one!)).toBe("i32");
		expect(fn.valueRepresentation(two!)).toBe("i32");
		expect(fn.valueRepresentation(sum!)).toBe("f64");
	});

	it("keeps numeric coercion boxed when its numeric input must remain boxed", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [source] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [numeric] = builder.appendInstruction(entry, "unary", [source!], {
			attributes: { operator: "tonumeric" },
		});
		const [incremented] = builder.appendInstruction(entry, "unary", [numeric!], {
			attributes: { operator: "increment" },
		});
		const [divisor] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [remainder] = builder.appendInstruction(entry, "binary", [source!, divisor!], {
			attributes: { operator: "%" },
		});
		builder.appendInstruction(entry, "rootUse", [remainder!], {
			outputCount: 0,
		});
		builder.appendInstruction(entry, "storeGlobal", [source!], {
			attributes: { index: 0 },
			outputCount: 0,
		});
		builder.setTerminator(entry, { kind: "return", value: incremented! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		new CoreFunctionPassScheduler(
			program,
			context,
			analyses,
			report,
			finished.function,
		).runComponent("proofs", CORE_PROOF_PASSES);
		expect(fn.valueRepresentation(source!)).toBe("boxed");
		expect(fn.valueRepresentation(numeric!)).toBe("boxed");
		expect(fn.valueRepresentation(incremented!)).toBe("boxed");
		expect(fn.valueRepresentation(remainder!)).toBe("boxed");
	});

	it("refreshes primitive effect proofs after operand kinds narrow", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [nullValue] = builder.appendInstruction(entry, "createNull", []);
		const [firstComparison] = builder.appendInstruction(
			entry,
			"binary",
			[parameter, nullValue!],
			{ attributes: { operator: "===" }, outputRepresentations: ["boolean"] },
		);
		const proof = builder.addFact({
			kind: "primitive-operator-effects",
			value: [COMPILER_VALUE_KIND_TOP, COMPILER_VALUE_KIND_TOP],
			claims: [],
			validity: {
				kind: "summary",
				digest: `primitive-operator:binary:${COMPILER_VALUE_KIND_TOP},${COMPILER_VALUE_KIND_TOP}`,
			},
			obligations: [],
			origin: "test-primitive-kinds",
		});
		const [secondComparison] = builder.appendInstruction(
			entry,
			"binary",
			[firstComparison!, parameter],
			{
				attributes: { operator: "===" },
				outputRepresentations: ["boolean"],
				effectRefinement: { effects: CORE_NO_EFFECTS, proof },
			},
		);
		builder.setTerminator(entry, { kind: "return", value: secondComparison! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const definition = inspectCoreValueDefinition(fn, secondComparison!);
		if (definition.kind !== "instruction") throw new Error("expected instruction result");
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		new CoreFunctionPassScheduler(
			program,
			context,
			analyses,
			report,
			finished.function,
		).runComponent("proofs", CORE_PROOF_PASSES);
		expect(fn.instructionEffectRefinement(definition.instruction)?.proof).toBe(proof);
		expect(fn.fact(proof)).toMatchObject({
			kind: "primitive-operator-effects",
			value: [COMPILER_VALUE_KIND_BOOLEAN, COMPILER_VALUE_KIND_TOP],
			claims: [{ kind: "effect", instruction: definition.instruction }],
		});
	});

	it("retracts a primitive effect proof after operator semantics change", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [left] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [right] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [result] = builder.appendInstruction(entry, "binary", [left!, right!], {
			attributes: { operator: "+" },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const definition = inspectCoreValueDefinition(fn, result!);
		if (definition.kind !== "instruction") throw new Error("Expected binary result");
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		new CoreFunctionPassScheduler(
			program,
			context,
			analyses,
			report,
			finished.function,
		).runComponent("proofs", CORE_PROOF_PASSES);
		const refinement = fn.instructionEffectRefinement(definition.instruction);
		expect(refinement).toBeDefined();
		const editor = CoreEditor.open(program, finished.function);
		editor.replaceInstruction(definition.instruction, "binary", [left!, right!], {
			attributes: { operator: "in" },
			effectRefinement: refinement,
		});
		editor.commit();
		new CoreFunctionPassScheduler(
			program,
			context,
			analyses,
			report,
			finished.function,
		).runComponent("proofs", CORE_PROOF_PASSES);
		expect(fn.instructionEffectRefinement(definition.instruction)).toBeUndefined();
		expect(fn.isFactLive(refinement!.proof)).toBe(false);
	});

	it("forwards memory across operators proven primitive", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const left = builder.createBlock();
		const right = builder.createBlock();
		const join = builder.createBlock();
		const condition = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const [before] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		const [leftNumber] = builder.appendInstruction(left, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [rightNumber] = builder.appendInstruction(right, "createNumber", [], {
			attributes: { value: 2 },
		});
		builder.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [leftNumber!] },
		});
		builder.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [rightNumber!] },
		});
		const number = builder.appendBlockParameter(join);
		const [one] = builder.appendInstruction(join, "createNumber", [], {
			attributes: { value: 1 },
		});
		builder.appendInstruction(join, "binary", [number, one!], {
			attributes: { operator: "+" },
		});
		const [after] = builder.appendInstruction(join, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [same] = builder.appendInstruction(join, "binary", [before!, after!], {
			attributes: { operator: "===" },
			outputRepresentations: ["boolean"],
		});
		builder.setTerminator(join, { kind: "return", value: same! });
		const function_ = builder.finish(entry).function;
		const fn = optimizeCore(
			{ program, context },
			{ verification: "per-pass" },
		).compilation.program.function(function_);
		expect(
			[...fn.instructionIds()].filter(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadGlobal",
			),
		).toHaveLength(1);
		expect(
			[...fn.factIds()].some(
				(fact) => fn.fact(fact).kind === "primitive-operator-effects",
			),
		).toBe(true);
	});

	it("materializes exact strings carried through exception handlers", () => {
		let handlerRepresentations: ReadonlyArray<string> | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`function carry(callback) {
					let message = "base";
					try {
						if (callback()) message += "suffix";
						callback();
					} catch (error) {}
					return message;
				}`,
				"core-exception-scalar.js",
			),
			{
				afterCoreOptimization(program) {
					const fn = coreFunctionNamed(program, "carry");
					if (fn === undefined) throw new Error("Expected carry function");
					const handler = [...fn.blockIds()].find(
						(block) => inspectCoreBlockParameters(fn, block)[0]?.role === "exception",
					);
					expect(handler).toBeDefined();
					handlerRepresentations = inspectCoreBlockParameters(fn, handler!)
						.slice(1)
						.map(({ representation }) => representation);
				},
			},
		);
		expect(handlerRepresentations).toContain("string");
	});

	it("materializes exact numbers and booleans carried through exception handlers", () => {
		for (const [sourcePath, declaration, update, representation] of [
			["core-exception-f64.js", "let value = 1.5;", "value = 2.5;", "f64"],
			["core-exception-boolean.js", "let value = true;", "value = false;", "boolean"],
		] as const) {
			let handlerRepresentations: ReadonlyArray<string> | undefined;
			compileSemanticProgramToProgramImage(
				analyzeSourceAndRunSemanticAnalysis(
					`function carry(callback) {
						${declaration}
						try {
							if (callback()) ${update}
							callback();
						} catch (error) {}
						return value;
					}`,
					sourcePath,
				),
				{
					afterCoreOptimization(program) {
						const fn = coreFunctionNamed(program, "carry");
						if (fn === undefined) throw new Error("Expected carry function");
						const handler = [...fn.blockIds()].find(
							(block) => inspectCoreBlockParameters(fn, block)[0]?.role === "exception",
						);
						expect(handler).toBeDefined();
						handlerRepresentations = inspectCoreBlockParameters(fn, handler!)
							.slice(1)
							.map(({ representation: carried }) => carried);
					},
				},
			);
			expect(handlerRepresentations).toContain(representation);
		}
	});

	it("invalidates fact availability after replacement without discarding CFG or kind analyses", () => {
		const program = new CoreProgram(coreOpcodeRegistry);
		const functions = Array.from({ length: 2 }, () => {
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const value = inspectCoreBlockParameters(builder, entry)[0]!.value;
			builder.setTerminator(entry, { kind: "return", value });
			return { ...builder.finish(entry), value };
		});
		const create = CoreEditor.open(program, functions[0]!.function);
		const fact = create.addFact({
			kind: "local-test",
			value: true,
			claims: [{ kind: "identity", subject: functions[0]!.value, identities: [1] }],
			validity: { kind: "summary", digest: "test:true" },
			obligations: [],
			origin: "test",
		});
		create.commit();
		const report = new CoreOptimizationReportBuilder(program);
		const analyses = new CoreAnalysisManager(program, context, report);
		const firstCfg = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
				scope: "function",
				function: functions[0]!.function,
			})
			.exceptional();
		const firstFacts = analyses.get(CORE_FACT_AVAILABILITY_ANALYSIS, {
			scope: "function",
			function: functions[0]!.function,
		});
		const firstKinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
			scope: "function",
			function: functions[0]!.function,
		});
		const otherKinds = analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
			scope: "function",
			function: functions[1]!.function,
		});
		const editor = CoreEditor.open(program, functions[0]!.function);
		editor.replaceFact(fact, {
			kind: "local-test",
			value: false,
			claims: [{ kind: "identity", subject: functions[0]!.value, identities: [2] }],
			validity: { kind: "summary", digest: "test:false" },
			obligations: [],
			origin: "test",
		});
		const changes = editor.commit();
		expect(changes.domains).toEqual(["facts", "specializationInputs"]);
		expect(changes.facts).toEqual([fact]);
		expect(
			analyses
				.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
					scope: "function",
					function: functions[0]!.function,
				})
				.exceptional(),
		).toBe(firstCfg);
		expect(
			analyses.get(CORE_FACT_AVAILABILITY_ANALYSIS, {
				scope: "function",
				function: functions[0]!.function,
			}),
		).not.toBe(firstFacts);
		expect(
			analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
				scope: "function",
				function: functions[0]!.function,
			}),
		).toBe(firstKinds);
		expect(
			analyses.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, {
				scope: "function",
				function: functions[1]!.function,
			}),
		).toBe(otherKinds);
	});
});
