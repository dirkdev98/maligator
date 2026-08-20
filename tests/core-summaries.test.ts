import { describe, expect, it } from "vitest";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	coreOptimizationMetrics,
	executeCoreOptimizations,
} from "../src/compiler/core/core-ir-opt.ts";
import {
	CORE_CALL_EFFECT_SUMMARY_FACT,
	analyzeCoreProgramSummaries,
	coreFunctionEffectSummaries,
	coreModuleEffectSummaries,
	deriveCoreCallEffectRefinement,
} from "../src/compiler/core/core-ir-summaries.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";
import { lowerCoreProgramToTarget } from "../src/compiler/target/core-target-lowering.ts";
import { emitVmDefinition } from "../src/compiler/target/emit-vm.ts";

function coreProgram(
	functions: ReadonlyArray<CoreFunction>,
	globalCount = 0,
): CoreProgram {
	return {
		functions,
		stringConstants: [[]],
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount,
	};
}

function returnParameter(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const parameter = builder.block(entry).parameters[0]!.value;
	builder.setTerminator(entry, { kind: "return", value: parameter });
	return builder.finish(entry);
}

function returnF64(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [value] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 1.5 },
		outputRepresentations: ["f64"],
	});
	builder.setTerminator(entry, { kind: "return", value: value! });
	return builder.finish(entry);
}

function returnBoolean(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [value] = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
		outputRepresentations: ["boolean"],
	});
	builder.setTerminator(entry, { kind: "return", value: value! });
	return builder.finish(entry);
}

function writeGlobal(functionIndex: number, slot = 0): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const parameter = builder.block(entry).parameters[0]!.value;
	builder.appendInstruction(entry, "storeGlobal", [parameter], {
		attributes: { index: slot },
	});
	builder.setTerminator(entry, { kind: "return", value: parameter });
	return builder.finish(entry);
}

function ignoreParameter(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const [result] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 2 },
		outputRepresentations: ["f64"],
	});
	builder.setTerminator(entry, { kind: "return", value: result! });
	return builder.finish(entry);
}

function mutateParameter(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const parameter = builder.block(entry).parameters[0]!.value;
	const [value] = builder.appendInstruction(entry, "createF64", [], {
		attributes: { value: 2 },
		outputRepresentations: ["f64"],
	});
	builder.appendInstruction(entry, "storePropertyStatic", [parameter, value!], {
		attributes: { stringIndex: 1 },
	});
	builder.setTerminator(entry, { kind: "return", value: value! });
	return builder.finish(entry);
}

function objectCaller(
	functionIndex: number,
	target: number,
	throughResult: boolean,
): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const initial = builder.block(entry).parameters[0]!.value;
	const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial], {
		attributes: { keyStringIndices: [1] },
	});
	const { result } = appendDirectCall(builder, entry, target, object);
	const [loaded] = builder.appendInstruction(
		entry,
		"loadPropertyStatic",
		[throughResult ? result : object!],
		{ attributes: { stringIndex: 1 } },
	);
	builder.setTerminator(entry, { kind: "return", value: loaded! });
	return builder.finish(entry);
}

function appendDirectCall(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
	target: number,
	argument?: CoreValueId,
): {
	readonly callee: CoreValueId;
	readonly call: CoreInstruction;
	readonly result: CoreValueId;
} {
	const [callee] = builder.appendInstruction(block, "createFunction", [], {
		attributes: { functionIndex: target },
	});
	const [thisValue] = builder.appendInstruction(block, "createUndefined", []);
	const [result] = builder.appendInstruction(
		block,
		"call",
		argument === undefined ? [callee!, thisValue!] : [callee!, thisValue!, argument],
	);
	const call = builder
		.block(block)
		.instructions.find((instruction) => instruction.outputs.includes(result!))!;
	return { callee: callee!, call, result: result! };
}

function directCaller(functionIndex: number, target: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const { result } = appendDirectCall(builder, entry, target);
	builder.setTerminator(entry, { kind: "return", value: result });
	return builder.finish(entry);
}

function callInstructions(fn: CoreFunction): ReadonlyArray<CoreInstruction> {
	return fn.blocks
		.flatMap(({ instructions }) => instructions)
		.filter(({ opcode }) => opcode === "call");
}

describe("interprocedural summary lattices", () => {
	it("collects escape, provenance, and representation independently", () => {
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([returnParameter(0), returnF64(1)]),
		);
		expect(analysis.summary(0)).toMatchObject({
			parameterEscape: ["returned"],
			parameterContainment: ["preserved"],
			returnProvenance: { kind: "parameter", index: 0 },
			returnRepresentation: "boxed",
		});
		expect(analysis.summary(1)).toMatchObject({
			parameterEscape: [],
			returnProvenance: { kind: "primitive" },
			returnRepresentation: "f64",
		});
	});

	it("reports the fresh boundary object returned by generators and async functions", () => {
		const generator = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			isGenerator: true,
			parameterCount: 1,
		});
		const generatorEntry = generator.createBlock([{}]);
		generator.setTerminator(generatorEntry, {
			kind: "return",
			value: generator.block(generatorEntry).parameters[0]!.value,
		});
		const async = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			isAsync: true,
			parameterCount: 1,
		});
		const asyncEntry = async.createBlock([{}]);
		async.setTerminator(asyncEntry, {
			kind: "return",
			value: async.block(asyncEntry).parameters[0]!.value,
		});
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([generator.finish(generatorEntry), async.finish(asyncEntry)]),
		);
		for (const summary of analysis.functions) {
			expect(summary.returnProvenance).toEqual({ kind: "fresh" });
			expect(summary.returnRepresentation).toBe("boxed");
			expect(summary.parameterEscape).toEqual(["retained"]);
		}
	});

	it("joins two closed targets without losing their independent effects", () => {
		const caller = new CoreFunctionBuilder(2, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = caller.createBlock([{}]);
		const condition = caller.block(entry).parameters[0]!.value;
		const left = caller.createBlock();
		const right = caller.createBlock();
		const join = caller.createBlock([{}]);
		const [first] = caller.appendInstruction(left, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		const [second] = caller.appendInstruction(right, "createFunction", [], {
			attributes: { functionIndex: 1 },
		});
		caller.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: left, arguments: [] },
			alternate: { block: right, arguments: [] },
		});
		caller.setTerminator(left, {
			kind: "jump",
			edge: { block: join, arguments: [first!] },
		});
		caller.setTerminator(right, {
			kind: "jump",
			edge: { block: join, arguments: [second!] },
		});
		const callee = caller.block(join).parameters[0]!.value;
		const [thisValue] = caller.appendInstruction(join, "createUndefined", []);
		const [result] = caller.appendInstruction(join, "call", [callee, thisValue!]);
		const call = caller.block(join).instructions.at(-1)!;
		caller.setTerminator(join, { kind: "return", value: result! });
		const completeCaller = caller.finish(entry);

		const analysis = analyzeCoreProgramSummaries(
			coreProgram([returnParameter(0), writeGlobal(1), completeCaller], 1),
		);
		const claim = analysis.callSite(2, call.id)!;
		expect(claim.targets).toEqual([0, 1]);
		expect(claim.effects.writes).toContain("global-slot");
		expect(claim.effects.mayThrow).toBe(true);
		expect(analysis.summary(2)?.callees).toEqual([0, 1]);
	});

	it("converges a recursive SCC while retaining call-frame throw and GC", () => {
		const recursive = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = recursive.createBlock();
		appendDirectCall(recursive, entry, 0);
		const [result] = recursive.appendInstruction(entry, "createUndefined", []);
		recursive.setTerminator(entry, { kind: "return", value: result! });
		const analysis = analyzeCoreProgramSummaries(coreProgram([recursive.finish(entry)]));
		expect(analysis.statistics).toMatchObject({
			components: 1,
			cyclicComponents: 1,
			saturatedComponents: 0,
		});
		expect(analysis.summary(0)?.effects).toMatchObject({
			mayThrow: true,
			mayGc: true,
		});
	});

	it("does not form a claim for an opaque callee", () => {
		const caller = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = caller.createBlock([{}]);
		const callee = caller.block(entry).parameters[0]!.value;
		const [thisValue] = caller.appendInstruction(entry, "createUndefined", []);
		const [result] = caller.appendInstruction(entry, "call", [callee, thisValue!]);
		const call = caller.block(entry).instructions.at(-1)!;
		caller.setTerminator(entry, { kind: "return", value: result! });
		const analysis = analyzeCoreProgramSummaries(coreProgram([caller.finish(entry)]));
		expect(analysis.callSite(0, call.id)).toBeUndefined();
		expect(analysis.summary(0)).toMatchObject({ openCallEdge: true });
	});

	it("widens target overflow and refuses to form a summary claim", () => {
		const functions = Array.from({ length: 5 }, (_, index) => returnParameter(index));
		const caller = new CoreFunctionBuilder(5, coreOpcodeRegistry);
		const entry = caller.createBlock();
		for (let target = 0; target < 5; target += 1) {
			const [created] = caller.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: target },
			});
			caller.appendInstruction(entry, "storeGlobal", [created!], {
				attributes: { index: 0 },
			});
		}
		const [callee] = caller.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [thisValue] = caller.appendInstruction(entry, "createUndefined", []);
		const [result] = caller.appendInstruction(entry, "call", [callee!, thisValue!]);
		const call = caller.block(entry).instructions.at(-1)!;
		caller.setTerminator(entry, { kind: "return", value: result! });
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([...functions, caller.finish(entry)], 1),
		);
		expect(analysis.targets.targets(5, callee!).anyScript).toBe(true);
		expect(analysis.callSite(5, call.id)).toBeUndefined();
	});

	it("reports graph-derived open-world roots without pretending source closure", () => {
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([returnParameter(0), returnF64(1)]),
		);
		expect(analysis.sourceClosed).toBe(false);
		expect(analysis.closureOpenings).toEqual([]);
		for (const summary of analysis.functions) {
			expect(summary.rootReasons).toContain("open-world");
			expect(summary.externallyReachable).toBe(true);
		}
	});
});

describe("summary consumers and proof boundary", () => {
	it("lets memory forwarding cross a proven read/write-free call only", () => {
		const buildCaller = (functionIndex: number, target: "known" | "open") => {
			const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
				parameterCount: 1,
			});
			const entry = builder.createBlock([{}]);
			const stored = builder.block(entry).parameters[0]!.value;
			builder.appendInstruction(entry, "storeGlobal", [stored], {
				attributes: { index: functionIndex - 1 },
			});
			if (target === "known") {
				appendDirectCall(builder, entry, 0);
			} else {
				const [callee] = builder.appendInstruction(entry, "loadIntrinsic", [], {
					attributes: { intrinsic: "Object" },
				});
				builder.appendInstruction(entry, "call", [callee!, stored]);
			}
			const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: functionIndex - 1 },
			});
			builder.setTerminator(entry, { kind: "return", value: loaded! });
			return builder.finish(entry);
		};
		const optimized = executeCoreOptimizations(
			coreProgram(
				[returnParameter(0), buildCaller(1, "known"), buildCaller(2, "open")],
				2,
			),
			{ ablations: new Set(["inlining"]), verification: "per-pass" },
		).program;
		const loads = (index: number) =>
			optimized.functions[index]!.blocks.flatMap(
				({ instructions }) => instructions,
			).filter(({ opcode }) => opcode === "loadGlobal").length;
		expect(loads(1)).toBe(0);
		expect(loads(2)).toBe(1);
		const knownCall = callInstructions(optimized.functions[1]!)[0]!;
		expect(knownCall.effectRefinement?.effects).toMatchObject({
			reads: [],
			writes: [],
			mayThrow: true,
			mayGc: true,
			callsUserCode: false,
		});
	});

	it("unboxes closed script results at the boxed ABI boundary and removes roots", () => {
		const program = coreProgram([
			returnF64(0),
			directCaller(1, 0),
			returnBoolean(2),
			directCaller(3, 2),
		]);
		const boxed = executeCoreOptimizations(program, {
			ablations: new Set(["inlining", "interprocedural"]),
			verification: "per-pass",
		}).program;
		const optimized = executeCoreOptimizations(program, {
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		}).program;
		const resultRepresentation = (functionIndex: number) => {
			const fn = optimized.functions[functionIndex]!;
			const call = callInstructions(fn)[0]!;
			return fn.values[call.outputs[0]!]!.representation;
		};
		expect(resultRepresentation(1)).toBe("f64");
		expect(resultRepresentation(3)).toBe("boolean");
		expect(coreOptimizationMetrics(optimized).rootedValues).toBeLessThan(
			coreOptimizationMetrics(boxed).rootedValues,
		);

		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`{
			 const numeric = () => 1.5;
			 const truth = () => true;
			 globalThis.__summaryResult = numeric() + (truth() ? 1 : 0);
			 }`,
			"summary-unboxing.js",
		);
		let productCore: CoreProgram | undefined;
		const vm = compileSemanticProgramToVmDefinition(semantic, {
			optimizationAblations: new Set(["inlining"]),
			afterCoreOptimization(program) {
				productCore = program;
			},
		});
		const target = lowerCoreProgramToTarget(productCore!);
		const emitted = emitVmDefinition(vm, { compiled: true });
		expect(emitted).toMatch(/mal_ops_number_as_f64\(call_result_\d+\.value\)/);
		expect(emitted).toMatch(/mal_value_to_boolean\(call_result_\d+\.value\)/);
		expect(
			target.functions
				.flatMap(({ blocks }) =>
					blocks.flatMap(({ instructions }) =>
						instructions.filter(({ type }) => type === "call"),
					),
				)
				.some((instruction) => "calleeSummary" in instruction),
		).toBe(false);
	});

	it("keeps exact allocation provenance only across containment-preserving callees", () => {
		const program: CoreProgram = {
			...coreProgram([
				ignoreParameter(0),
				returnParameter(1),
				mutateParameter(2),
				objectCaller(3, 0, false),
				objectCaller(4, 1, true),
				objectCaller(5, 2, false),
			]),
			stringConstants: [[], [102]],
		};
		const optimized = executeCoreOptimizations(program, {
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		}).program;
		const ablated = executeCoreOptimizations(program, {
			ablations: new Set(["inlining", "interprocedural"]),
			verification: "per-pass",
		}).program;
		const loads = (candidate: CoreProgram, functionIndex: number) =>
			candidate.functions[functionIndex]!.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "loadPropertyStatic"),
			).length;
		expect(loads(optimized, 3)).toBe(0);
		expect(loads(optimized, 4)).toBe(0);
		expect(loads(optimized, 5)).toBe(1);
		expect(loads(ablated, 3)).toBe(1);
		expect(loads(ablated, 4)).toBe(1);
		expect(loads(ablated, 5)).toBe(1);
		expect(analyzeCoreProgramSummaries(program).summary(2)).toMatchObject({
			parameterContainment: ["unknown"],
		});
	});

	it("propagates a pure effect summary transitively to memory consumers", () => {
		const caller = new CoreFunctionBuilder(2, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = caller.createBlock([{}]);
		const stored = caller.block(entry).parameters[0]!.value;
		caller.appendInstruction(entry, "storeGlobal", [stored], {
			attributes: { index: 0 },
		});
		appendDirectCall(caller, entry, 1);
		const [loaded] = caller.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		caller.setTerminator(entry, { kind: "return", value: loaded! });
		const optimized = executeCoreOptimizations(
			coreProgram([returnParameter(0), directCaller(1, 0), caller.finish(entry)], 1),
			{ ablations: new Set(["inlining"]), verification: "per-pass" },
		).program;
		expect(
			optimized.functions[2]!.blocks.flatMap(({ instructions }) => instructions).filter(
				({ opcode }) => opcode === "loadGlobal",
			),
		).toHaveLength(0);
	});

	it("keeps effect dimensions conservative when the callee writes", () => {
		const caller = directCaller(1, 0);
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([writeGlobal(0), caller], 1),
		);
		const call = callInstructions(caller)[0]!;
		const claim = analysis.callSite(1, call.id)!;
		const baseline = coreOpcodeRegistry.require("call").effects;
		const refinement = deriveCoreCallEffectRefinement(baseline, claim);
		expect(claim.effects.writes).toContain("global-slot");
		expect(refinement?.mayThrow).toBe(true);
		expect(refinement?.mayGc).toBe(true);
		expect(refinement?.callsUserCode).toBe(true);
	});

	it("refuses refinement when a transitive callee can invoke unknown user code", () => {
		const userCaller = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = userCaller.createBlock([{}]);
		const unknown = userCaller.block(entry).parameters[0]!.value;
		const [thisValue] = userCaller.appendInstruction(entry, "createUndefined", []);
		const [result] = userCaller.appendInstruction(entry, "call", [unknown, thisValue!]);
		userCaller.setTerminator(entry, { kind: "return", value: result! });
		const caller = directCaller(1, 0);
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([userCaller.finish(entry), caller]),
		);
		const claim = analysis.callSite(1, callInstructions(caller)[0]!.id)!;
		expect(claim.effects.callsUserCode).toBe(true);
		expect(
			deriveCoreCallEffectRefinement(coreOpcodeRegistry.require("call").effects, claim),
		).toBeUndefined();
	});

	it("rejects a summary proof after its closed target changes", () => {
		const optimized = executeCoreOptimizations(
			coreProgram([returnParameter(0), directCaller(1, 0), writeGlobal(2)], 1),
			{ ablations: new Set(["inlining"]), verification: "per-pass" },
		).program;
		const caller = optimized.functions[1]!;
		expect(caller.facts.some(({ kind }) => kind === CORE_CALL_EFFECT_SUMMARY_FACT)).toBe(
			true,
		);
		const staleCaller: CoreFunction = {
			...caller,
			blocks: caller.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) =>
					instruction.opcode === "createFunction"
						? {
								...instruction,
								attributes: { ...instruction.attributes, functionIndex: 2 },
							}
						: instruction,
				),
			})),
			mutationEpoch: caller.mutationEpoch + 1,
		};
		const stale = {
			...optimized,
			functions: optimized.functions.map((fn) =>
				fn.functionIndex === 1 ? staleCaller : fn,
			),
		};
		expect(() => verifyCoreProgram(stale, coreOpcodeRegistry)).toThrow(
			/callee summary|callee-summary|targets/,
		);
	});

	it("rejects an unboxed call result after the callee widens to boxed", () => {
		const optimized = executeCoreOptimizations(
			coreProgram([returnF64(0), directCaller(1, 0)]),
			{ ablations: new Set(["inlining"]), verification: "per-pass" },
		).program;
		const call = callInstructions(optimized.functions[1]!)[0]!;
		expect(optimized.functions[1]!.values[call.outputs[0]!]!.representation).toBe("f64");
		const stale: CoreProgram = {
			...optimized,
			functions: [returnParameter(0), optimized.functions[1]!],
		};
		expect(() => verifyCoreProgram(stale, coreOpcodeRegistry)).toThrow(
			/callee value facts|licenses boxed/,
		);
	});

	it("rejects a containment claim after the callee starts mutating its argument", () => {
		const program: CoreProgram = {
			...coreProgram([ignoreParameter(0), objectCaller(1, 0, false)]),
			stringConstants: [[], [102]],
		};
		const optimized = executeCoreOptimizations(program, {
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		}).program;
		expect(
			optimized.functions[1]!.blocks.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "loadPropertyStatic"),
			),
		).toHaveLength(0);
		const stale: CoreProgram = {
			...optimized,
			functions: [mutateParameter(0), optimized.functions[1]!],
		};
		expect(() => verifyCoreProgram(stale, coreOpcodeRegistry)).toThrow(
			/callee summary the current graph no longer proves/,
		);
	});

	it("publishes deterministic function and module summary maps", () => {
		const summaries = analyzeCoreProgramSummaries(
			coreProgram([returnParameter(0), directCaller(1, 0)]),
		);
		const functions = coreFunctionEffectSummaries(summaries);
		const modules = coreModuleEffectSummaries(summaries);
		expect([...functions.keys()]).toEqual([...functions.keys()].sort());
		expect([...modules.keys()]).toEqual([...modules.keys()].sort());
		expect(functions.size).toBe(2);
		expect(modules.size).toBe(1);
	});

	it("publishes summaries through the ordinary compiler facts object", () => {
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			"function pure(value) { return value; } pure(1);",
			"summary-publication.js",
		);
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToVmDefinition(semantic, {
			optimizationAblations: new Set(["inlining"]),
			afterCoreOptimization(program) {
				optimized = program;
			},
		});
		expect(optimized?.compilation?.facts.functionEffects.size).toBeGreaterThan(0);
		expect(optimized?.compilation?.facts.moduleEffects.size).toBeGreaterThan(0);
	});
});
