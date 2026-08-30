import { describe, expect, it } from "vitest";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
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
import { CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE } from "../src/compiler/core/core-ir-value-kinds.ts";
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
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";

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

function asyncIgnoreParameter(functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		isAsync: true,
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const [result] = builder.appendInstruction(entry, "createUndefined", []);
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

function directConstructor(functionIndex: number, target: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const [callee] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: target },
	});
	const [result] = builder.appendInstruction(entry, "construct", [callee!]);
	builder.setTerminator(entry, { kind: "return", value: result! });
	return builder.finish(entry);
}

function finiteTargetCaller(
	functionIndex: number,
	firstTarget: number,
	secondTarget: number,
): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount: 1,
	});
	const entry = builder.createBlock([{}]);
	const condition = builder.block(entry).parameters[0]!.value;
	const firstBlock = builder.createBlock();
	const secondBlock = builder.createBlock();
	const join = builder.createBlock([{}]);
	const [first] = builder.appendInstruction(firstBlock, "createFunction", [], {
		attributes: { functionIndex: firstTarget },
	});
	const [second] = builder.appendInstruction(secondBlock, "createFunction", [], {
		attributes: { functionIndex: secondTarget },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition,
		consequent: { block: firstBlock, arguments: [] },
		alternate: { block: secondBlock, arguments: [] },
	});
	builder.setTerminator(firstBlock, {
		kind: "jump",
		edge: { block: join, arguments: [first!] },
	});
	builder.setTerminator(secondBlock, {
		kind: "jump",
		edge: { block: join, arguments: [second!] },
	});
	const callee = builder.block(join).parameters[0]!.value;
	const [thisValue] = builder.appendInstruction(join, "createUndefined", []);
	const [result] = builder.appendInstruction(join, "call", [callee, thisValue!]);
	builder.setTerminator(join, { kind: "return", value: result! });
	return builder.finish(entry);
}

function finiteIdentityCaller(
	functionIndex: number,
	firstTarget: number,
	secondTarget: number,
): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount: 2,
	});
	const entry = builder.createBlock([{}, {}]);
	const [condition, initial] = builder.block(entry).parameters.map(({ value }) => value);
	const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
		attributes: { keyStringIndices: [1] },
	});
	const firstBlock = builder.createBlock();
	const secondBlock = builder.createBlock();
	const join = builder.createBlock([{}]);
	const [first] = builder.appendInstruction(firstBlock, "createFunction", [], {
		attributes: { functionIndex: firstTarget },
	});
	const [second] = builder.appendInstruction(secondBlock, "createFunction", [], {
		attributes: { functionIndex: secondTarget },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition: condition!,
		consequent: { block: firstBlock, arguments: [] },
		alternate: { block: secondBlock, arguments: [] },
	});
	builder.setTerminator(firstBlock, {
		kind: "jump",
		edge: { block: join, arguments: [first!] },
	});
	builder.setTerminator(secondBlock, {
		kind: "jump",
		edge: { block: join, arguments: [second!] },
	});
	const callee = builder.block(join).parameters[0]!.value;
	const [thisValue] = builder.appendInstruction(join, "createUndefined", []);
	const [result] = builder.appendInstruction(join, "call", [callee, thisValue!, object!]);
	const [loaded] = builder.appendInstruction(join, "loadPropertyStatic", [result!], {
		attributes: { stringIndex: 1 },
	});
	builder.setTerminator(join, { kind: "return", value: loaded! });
	return builder.finish(entry);
}

function callInstructions(fn: CoreFunction): ReadonlyArray<CoreInstruction> {
	return coreInstructions(fn, "call");
}

function coreInstructions(
	fn: CoreFunction,
	opcode: string,
): ReadonlyArray<CoreInstruction> {
	return fn.blocks
		.flatMap(({ instructions }) => instructions)
		.filter((instruction) => instruction.opcode === opcode);
}

/**
 * A strict, unmapped frame that hands one `arguments` producer's result to a
 * global slot. `mappedArguments` stays false, so the summary has to attribute the
 * escape through the producer rather than through the mapped-frame shortcut.
 */
function escapingArgumentsProducer(
	functionIndex: number,
	opcode: "createArgumentsObject" | "createRestArguments" | "loadArgument",
	parameterCount: number,
	attributes: Record<string, number> = {},
): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		parameterCount,
		metadata: { strict: true, sourceStrict: true, mappedArguments: false },
	});
	const entry = builder.createBlock(Array.from({ length: parameterCount }, () => ({})));
	const [produced] = builder.appendInstruction(entry, opcode, [], {
		attributes,
	});
	builder.appendInstruction(entry, "storeGlobal", [produced!], {
		attributes: { index: 0 },
	});
	const [undefinedValue] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: undefinedValue! });
	return builder.finish(entry);
}

/** `class Derived extends Parent { constructor(...args) { super(...args); } }` */
function derivedConstructor(functionIndex: number, parent: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		metadata: { isClassConstructor: true, isDerivedConstructor: true },
	});
	const entry = builder.createBlock();
	const [parentValue] = builder.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: parent },
	});
	const [args] = builder.appendInstruction(entry, "createRestArguments", [], {
		attributes: { startIndex: 0 },
	});
	builder.appendInstruction(entry, "constructSuper", [parentValue!, args!]);
	const [undefinedValue] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: undefinedValue! });
	return builder.finish(entry);
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

	it("reports fresh generator and async boundary objects without blanket async retention", () => {
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
		}
		expect(analysis.summary(0)?.parameterEscape).toEqual(["retained"]);
		expect(analysis.summary(1)?.parameterEscape).toEqual(["returned"]);
	});

	it("retains only async values live across suspension", () => {
		const asynchronous = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			isAsync: true,
			parameterCount: 2,
		});
		const entry = asynchronous.createBlock([{}, {}]);
		const [before, after] = asynchronous
			.block(entry)
			.parameters.map(({ value }) => value);
		asynchronous.appendInstruction(entry, "unary", [before!], {
			attributes: { operator: "typeof" },
		});
		const [awaited] = asynchronous.appendInstruction(entry, "createUndefined", []);
		asynchronous.appendInstruction(entry, "await", [awaited!], { outputCount: 2 });
		const [result] = asynchronous.appendInstruction(entry, "unary", [after!], {
			attributes: { operator: "typeof" },
		});
		asynchronous.setTerminator(entry, { kind: "return", value: result! });
		const summary = analyzeCoreProgramSummaries(
			coreProgram([asynchronous.finish(entry)]),
		).summary(0)!;
		expect(summary.parameterEscape).toEqual(["none", "retained"]);
		expect(summary.parameterContainment).toEqual(["preserved", "unknown"]);
	});

	it("consumes async suspension liveness for allocation containment", () => {
		const program: CoreProgram = {
			...coreProgram([asyncIgnoreParameter(0), objectCaller(1, 0, false)]),
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
		expect(analyzeCoreProgramSummaries(program).summary(0)).toMatchObject({
			parameterEscape: ["none"],
			parameterContainment: ["preserved"],
		});
		expect(coreInstructions(optimized.functions[1]!, "loadPropertyStatic")).toHaveLength(
			0,
		);
		expect(coreInstructions(ablated.functions[1]!, "loadPropertyStatic")).toHaveLength(1);
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

	it("consumes a callee reached through a static module-namespace export", () => {
		const caller = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const entry = caller.createBlock();
		const [created] = caller.appendInstruction(entry, "createFunction", [], {
			attributes: { functionIndex: 0 },
		});
		caller.appendInstruction(entry, "storeGlobal", [created!], {
			attributes: { index: 0 },
		});
		const [namespace] = caller.appendInstruction(entry, "createModuleNamespace", [], {
			attributes: { exports: [{ nameStringIndex: 1, slot: 0 }] },
		});
		const [callee] = caller.appendInstruction(entry, "loadPropertyStatic", [namespace!], {
			attributes: { stringIndex: 1 },
		});
		const [thisValue] = caller.appendInstruction(entry, "createUndefined", []);
		const [result] = caller.appendInstruction(entry, "call", [callee!, thisValue!]);
		const call = caller.block(entry).instructions.at(-1)!;
		caller.setTerminator(entry, { kind: "return", value: result! });
		const shell = coreProgram([returnParameter(0), caller.finish(entry)], 1);
		const program: CoreProgram = {
			...shell,
			stringConstants: [[], [..."run"].map((character) => character.codePointAt(0)!)],
		};

		const analysis = analyzeCoreProgramSummaries(program);
		expect(analysis.callSite(1, call.id)?.targets).toEqual([0]);
		// The generic property opcode still carries a possible user-code edge; that
		// does not prevent the following call itself from consuming the exact target.
		expect(analysis.summary(1)).toMatchObject({
			callees: [0],
			openCallEdge: true,
		});
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
		expect(analysis.summary(0)).toMatchObject({
			openCallEdge: true,
			returnRepresentation: "boxed",
		});
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

	it("attributes an unmapped arguments object to every formal parameter", () => {
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([escapingArgumentsProducer(0, "createArgumentsObject", 2)], 1),
		);
		expect(analysis.summary(0)).toMatchObject({
			parameterEscape: ["retained", "retained"],
			parameterContainment: ["unknown", "unknown"],
			restParameterEscape: "retained",
			restParameterContainment: "unknown",
		});
	});

	it("attributes a statically indexed argument read to that formal alone", () => {
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([escapingArgumentsProducer(0, "loadArgument", 3, { index: 1 })], 1),
		);
		expect(analysis.summary(0)).toMatchObject({
			parameterEscape: ["none", "retained", "none"],
			parameterContainment: ["preserved", "unknown", "preserved"],
			restParameterEscape: "none",
			restParameterContainment: "preserved",
		});
	});

	it("attributes a rest array to the formals its start index covers", () => {
		const analysis = analyzeCoreProgramSummaries(
			coreProgram(
				[
					escapingArgumentsProducer(0, "createRestArguments", 3, {
						startIndex: 1,
					}),
				],
				1,
			),
		);
		expect(analysis.summary(0)).toMatchObject({
			parameterEscape: ["none", "retained", "retained"],
			parameterContainment: ["preserved", "unknown", "unknown"],
			restParameterEscape: "retained",
		});
	});

	it("attributes an argument read past the formals to the rest bucket only", () => {
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([escapingArgumentsProducer(0, "loadArgument", 1, { index: 3 })], 1),
		);
		expect(analysis.summary(0)).toMatchObject({
			parameterEscape: ["none"],
			parameterContainment: ["preserved"],
			restParameterEscape: "retained",
			restParameterContainment: "unknown",
		});
	});

	it("records a superclass constructor reached only through super construction", () => {
		const derived = derivedConstructor(0, 1);
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([derived, writeGlobal(1)], 1),
		);
		expect(analysis.summary(0)?.callees).toEqual([1]);
		expect(analysis.summary(0)?.openCallEdge).toBe(false);
		expect(analysis.statistics.callEdges).toBe(1);
		// Super construction contributes the edge without becoming a claim site: no
		// operand maps onto a formal and the result is the constructed object.
		const construct = coreInstructions(derived, "constructSuper")[0]!;
		expect(analysis.callSite(0, construct.id)).toBeUndefined();
		expect(analysis.summary(0)?.effects.callsUserCode).toBe(true);
	});

	it("opens the edge set for an unresolvable super constructor", () => {
		const derived = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = derived.createBlock([{}]);
		const parent = derived.block(entry).parameters[0]!.value;
		const [args] = derived.appendInstruction(entry, "createRestArguments", [], {
			attributes: { startIndex: 0 },
		});
		derived.appendInstruction(entry, "constructSuper", [parent, args!]);
		const [undefinedValue] = derived.appendInstruction(entry, "createUndefined", []);
		derived.setTerminator(entry, { kind: "return", value: undefinedValue! });
		const analysis = analyzeCoreProgramSummaries(coreProgram([derived.finish(entry)]));
		expect(analysis.summary(0)).toMatchObject({
			callees: [],
			openCallEdge: true,
		});
	});

	it("opens the edge set for a non-call instruction that enters user code", () => {
		const reader = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = reader.createBlock([{}]);
		const base = reader.block(entry).parameters[0]!.value;
		const [loaded] = reader.appendInstruction(entry, "loadPropertyStatic", [base], {
			attributes: { stringIndex: 0 },
		});
		reader.setTerminator(entry, { kind: "return", value: loaded! });
		const analysis = analyzeCoreProgramSummaries(coreProgram([reader.finish(entry)]));
		// A getter is a call edge the lattice cannot name, so the edge set is open
		// even though the function contains no call opcode at all.
		expect(analysis.summary(0)).toMatchObject({
			callees: [],
			openCallEdge: true,
		});
		expect(analysis.summary(0)?.effects.callsUserCode).toBe(true);
	});

	it("refuses fresh identity for a cached tagged-template strings object", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [strings] = builder.appendInstruction(entry, "createTemplateObject", [], {
			attributes: { cacheSlot: 0, cookedIndices: [0], rawIndices: [0] },
		});
		builder.setTerminator(entry, { kind: "return", value: strings! });
		const analysis = analyzeCoreProgramSummaries(coreProgram([builder.finish(entry)], 1));
		expect(analysis.summary(0)?.returnProvenance).toEqual({ kind: "unknown" });
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

	it("relays closed script result representations into native calls", () => {
		const program = coreProgram([
			returnF64(0),
			directCaller(1, 0),
			directCaller(2, 1),
			returnBoolean(3),
			directCaller(4, 3),
			directCaller(5, 4),
		]);
		const boxed = executeCoreOptimizations(program, {
			ablations: new Set(["inlining", "interprocedural"]),
			verification: "per-pass",
		}).program;
		const optimized = executeCoreOptimizations(program, {
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		}).program;
		const summaries = analyzeCoreProgramSummaries(program);
		for (const index of [0, 1, 2]) {
			expect(summaries.summary(index)?.returnRepresentation).toBe("f64");
		}
		for (const index of [3, 4, 5]) {
			expect(summaries.summary(index)?.returnRepresentation).toBe("boolean");
		}
		const resultRepresentation = (functionIndex: number) => {
			const fn = optimized.functions[functionIndex]!;
			const call = callInstructions(fn)[0]!;
			return fn.values[call.outputs[0]!]!.representation;
		};
		expect(resultRepresentation(1)).toBe("f64");
		expect(resultRepresentation(2)).toBe("f64");
		expect(resultRepresentation(4)).toBe("boolean");
		expect(resultRepresentation(5)).toBe("boolean");
		expect(coreOptimizationMetrics(optimized).rootedValues).toBeLessThan(
			coreOptimizationMetrics(boxed).rootedValues,
		);

		const semantic = analyzeSourceAndRunSemanticAnalysis(
			`{
			 const numericLeaf = () => 1.5;
			 const numeric = () => numericLeaf();
			 const truthLeaf = () => true;
			 const truth = () => truthLeaf();
			 globalThis.__summaryResult = numeric() + (truth() ? 1 : 0);
			 }`,
			"summary-unboxing.js",
		);
		let productCore: CoreProgram | undefined;
		let productContext: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			optimizationAblations: new Set(["inlining"]),
			afterCoreOptimization(program, context) {
				productCore = program;
				productContext = context;
			},
		});
		const target = lowerCoreCompilationToExecution({
			program: productCore!,
			context: productContext!,
		});
		const functionIndex = (name: string): number =>
			productCore!.functions.find(
				(fn) =>
					String.fromCodePoint(
						...(productCore!.stringConstants[fn.metadata.nameStringIndex] ?? []),
					) === name,
			)!.functionIndex;
		for (const name of ["numeric", "truth"]) {
			const target = functionIndex(name);
			const located = productCore!.functions
				.flatMap((fn) =>
					fn.blocks.flatMap(({ instructions }) =>
						instructions.map((instruction) => ({ fn, instruction })),
					),
				)
				.find(
					({ instruction }) => instruction.attributes.directFunctionIndex === target,
				)!;
			expect(
				located.fn.values.find(({ id }) => id === located.instruction.outputs[0])
					?.representation,
			).toBe(name === "numeric" ? "f64" : "boolean");
		}
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

	it("consumes closed captured scalar kinds through joins and arithmetic", () => {
		const source = `const globalOffset = 2;
		function outer() {
			const fixedScale = 1.25;
			const fixedEnabled = true;
			return function inner(value) {
				const adjusted = value > 0 ? fixedScale : fixedScale;
				return fixedEnabled ? adjusted + adjusted + globalOffset : adjusted;
			};
		}
		const inner = outer();
		globalThis.__capturedScalarResult = inner(4);`;
		let optimized: CoreProgram | undefined;
		let context: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, "captured-scalar-representations.js"),
			{
				optimizationAblations: new Set(["inlining"]),
				afterCoreOptimization(program, compilationContext) {
					optimized = program;
					context = compilationContext;
				},
			},
		);
		const nameOf = (fn: CoreFunction): string =>
			String.fromCodePoint(
				...(optimized!.stringConstants[fn.metadata.nameStringIndex] ?? []),
			);
		const inner = optimized!.functions.find((fn) => nameOf(fn) === "inner")!;
		const representations = new Map(
			inner.values.map(({ id, representation }) => [id, representation] as const),
		);
		const capturedLoads = inner.blocks
			.flatMap(({ instructions }) => instructions)
			.filter(({ opcode }) => opcode === "loadCaptured");
		expect(capturedLoads).toHaveLength(3);
		expect(
			capturedLoads.map((instruction) => representations.get(instruction.outputs[0]!)),
		).toEqual(["boxed", "boxed", "boxed"]);
		const globalLoads = inner.blocks
			.flatMap(({ instructions }) => instructions)
			.filter(({ opcode }) => opcode === "loadGlobal");
		expect(globalLoads).toHaveLength(1);
		expect(representations.get(globalLoads[0]!.outputs[0]!)).toBe("boxed");
		const scalarMoves = inner.blocks
			.flatMap(({ instructions }) => instructions)
			.filter(
				(instruction) =>
					instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] !== undefined,
			);
		expect(scalarMoves).toHaveLength(4);
		expect(
			scalarMoves
				.map(
					(instruction) => instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE],
				)
				.sort(),
		).toEqual(["boolean", "int32", "number", "number"]);
		expect(
			scalarMoves
				.map((instruction) => representations.get(instruction.outputs[0]!))
				.sort(),
		).toEqual(["boolean", "f64", "f64", "i32"]);
		expect(
			scalarMoves.some(
				(instruction) => instruction.inputs[0] === globalLoads[0]!.outputs[0],
			),
		).toBe(true);
		const joined = inner.blocks
			.flatMap(({ parameters }) => parameters)
			.find(({ representation }) => representation === "f64");
		expect(joined).toBeDefined();
		const addition = inner.blocks
			.flatMap(({ instructions }) => instructions)
			.find(
				({ opcode, attributes }) => opcode === "binary" && attributes.operator === "+",
			)!;
		expect(representations.get(addition.outputs[0]!)).toBe("f64");
		expect(() =>
			verifyCoreProgram(optimized!, coreOpcodeRegistry, { stage: "pre-target" }, context),
		).not.toThrow();
	});

	it("keeps Int32, wide Number, signed zero, and String cell facts distinct", () => {
		const source = `const small = 7;
		const wide = 2147483648;
		const signedZero = -0;
		const label = "ready";
		function readCells() {
			globalThis.__small = small;
			globalThis.__wide = wide;
			globalThis.__signedZero = signedZero;
			globalThis.__label = label;
		}
		readCells();`;
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, "cell-value-kinds.js"),
			{
				optimizationAblations: new Set(["inlining"]),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const readCells = optimized!.functions.find(
			(fn) =>
				String.fromCodePoint(
					...(optimized!.stringConstants[fn.metadata.nameStringIndex] ?? []),
				) === "readCells",
		)!;
		const representations = new Map(
			readCells.values.map(({ id, representation }) => [id, representation] as const),
		);
		const moves = readCells.blocks
			.flatMap(({ instructions }) => instructions)
			.filter(
				(instruction) =>
					instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] !== undefined,
			);
		expect(
			moves.map(
				(instruction) => instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE],
			),
		).toEqual(["int32", "number", "number", "string"]);
		expect(
			moves.map((instruction) => representations.get(instruction.outputs[0]!)),
		).toEqual(["i32", "f64", "f64", "string"]);
	});

	it("keeps a multiply-assigned captured value boxed", () => {
		const source = `function outer() {
			let scale = 1.25;
			function inner() { return scale + scale; }
			scale = "changed";
			return inner;
		}
		const inner = outer();
		globalThis.__mutableCaptureResult = inner();`;
		let optimized: CoreProgram | undefined;
		compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, "mutable-capture-representation.js"),
			{
				optimizationAblations: new Set(["inlining"]),
				afterCoreOptimization(program) {
					optimized = program;
				},
			},
		);
		const scalarMoves = optimized!.functions.flatMap(({ blocks }) =>
			blocks.flatMap(({ instructions }) =>
				instructions.filter(
					(instruction) =>
						instruction.attributes[CORE_EXACT_SCALAR_AFTER_TDZ_ATTRIBUTE] !== undefined,
				),
			),
		);
		expect(scalarMoves).toEqual([]);
	});

	it("does not treat a constructor's primitive return as its construct result", () => {
		const analysis = analyzeCoreProgramSummaries(
			coreProgram([returnF64(0), directConstructor(1, 0)]),
		);
		expect(analysis.summary(0)?.returnRepresentation).toBe("f64");
		expect(analysis.summary(1)).toMatchObject({
			returnProvenance: { kind: "unknown" },
			returnRepresentation: "boxed",
		});
	});

	it("keeps an unread contained store of a returned construct result", () => {
		const caller = new CoreFunctionBuilder(2, coreOpcodeRegistry);
		const entry = caller.createBlock();
		const [initial] = caller.appendInstruction(entry, "createUndefined", []);
		const [holder] = caller.appendInstruction(entry, "createObjectShaped", [initial!], {
			attributes: { keyStringIndices: [1] },
		});
		const { result } = appendDirectCall(caller, entry, 1);
		caller.appendInstruction(entry, "storePropertyStatic", [holder!, result], {
			attributes: { stringIndex: 1 },
		});
		const [undefinedValue] = caller.appendInstruction(entry, "createUndefined", []);
		caller.setTerminator(entry, { kind: "return", value: undefinedValue! });

		const program: CoreProgram = {
			...coreProgram([returnF64(0), directConstructor(1, 0), caller.finish(entry)]),
			stringConstants: [[], [102]],
		};
		expect(analyzeCoreProgramSummaries(program).summary(1)).toMatchObject({
			returnProvenance: { kind: "unknown" },
			returnRepresentation: "boxed",
		});

		const optimized = executeCoreOptimizations(program, {
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		}).program;
		expect(coreInstructions(optimized.functions[2]!, "storePropertyStatic")).toHaveLength(
			1,
		);
		expect(coreInstructions(optimized.functions[2]!, "createObjectShaped")).toHaveLength(
			1,
		);
	});

	it("joins an exact returned call with a local boxed return", () => {
		const wrapper = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = wrapper.createBlock([{}]);
		const exact = wrapper.createBlock();
		const local = wrapper.createBlock();
		wrapper.setTerminator(entry, {
			kind: "branch",
			condition: wrapper.block(entry).parameters[0]!.value,
			consequent: { block: exact, arguments: [] },
			alternate: { block: local, arguments: [] },
		});
		const { result } = appendDirectCall(wrapper, exact, 0);
		wrapper.setTerminator(exact, { kind: "return", value: result });
		const [undefinedValue] = wrapper.appendInstruction(local, "createUndefined", []);
		wrapper.setTerminator(local, { kind: "return", value: undefinedValue! });

		const analysis = analyzeCoreProgramSummaries(
			coreProgram([returnF64(0), wrapper.finish(entry)]),
		);
		expect(analysis.summary(1)?.returnRepresentation).toBe("boxed");
	});

	it("joins finite return representations without trusting one callee", () => {
		const program = coreProgram([
			returnF64(0),
			returnF64(1),
			finiteTargetCaller(2, 0, 1),
			returnBoolean(3),
			finiteTargetCaller(4, 0, 3),
		]);
		const analysis = analyzeCoreProgramSummaries(program);
		const numericCall = callInstructions(program.functions[2]!)[0]!;
		expect(analysis.callSite(2, numericCall.id)).toMatchObject({
			targets: [0, 1],
			returnRepresentation: "f64",
		});

		const optimized = executeCoreOptimizations(program, {
			ablations: new Set(["inlining"]),
			verification: "per-pass",
		}).program;
		const representation = (functionIndex: number) => {
			const fn = optimized.functions[functionIndex]!;
			const call = callInstructions(fn)[0]!;
			return fn.values[call.outputs[0]!]!.representation;
		};
		expect(representation(2)).toBe("f64");
		expect(representation(4)).toBe("boxed");
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

	it("joins finite return provenance before forwarding object state", () => {
		const program: CoreProgram = {
			...coreProgram([
				returnParameter(0),
				returnParameter(1),
				finiteIdentityCaller(2, 0, 1),
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
		expect(coreInstructions(optimized.functions[2]!, "loadPropertyStatic")).toHaveLength(
			0,
		);
		expect(coreInstructions(ablated.functions[2]!, "loadPropertyStatic")).toHaveLength(1);
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
		let optimizedContext: CoreCompilationContext | undefined;
		compileSemanticProgramToProgramImage(semantic, {
			optimizationAblations: new Set(["inlining"]),
			afterCoreOptimization(program, context) {
				optimized = program;
				optimizedContext = context;
			},
		});
		expect(optimized).toBeDefined();
		expect(optimizedContext?.facts.functionEffects.size).toBeGreaterThan(0);
		expect(optimizedContext?.facts.moduleEffects.size).toBeGreaterThan(0);
	});
});
