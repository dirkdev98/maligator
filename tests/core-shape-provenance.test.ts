import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore as lowerSemanticProgramToCoreCompilation } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { executeCoreOptimizations } from "../src/compiler/core/core-ir-opt.ts";
import type { CoreOptimizationOptions } from "../src/compiler/core/core-ir-opt.ts";
import {
	CORE_KNOWN_OWN_SLOT_ATTRIBUTE,
	CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE,
	CORE_SHAPE_CASE_SLOTS_ATTRIBUTE,
	CORE_SHAPE_ORIGIN_CAP,
	analyzeCoreShapeProvenance,
	coreConstructorShapeLayout,
	coreKnownOwnSlotFromAttribute,
	rebaseCoreShapeProvenance,
	retractCoreKnownOwnSlots,
	selectCoreKnownOwnSlots,
} from "../src/compiler/core/core-ir-shape-provenance.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder, coreInstructionId } from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-native-program-image.ts";
import { coreCompilationForTest } from "./helpers/core-compilation.ts";

function lowerSemanticProgramToCore(
	...parameters: Parameters<typeof lowerSemanticProgramToCoreCompilation>
): CoreProgram {
	return lowerSemanticProgramToCoreCompilation(...parameters).program;
}

const STRINGS: ReadonlyArray<ReadonlyArray<number>> = [
	[],
	[120],
	[121],
	[122],
	[97],
	[98],
];

function coreProgram(
	functions: ReadonlyArray<CoreFunction>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = STRINGS,
): CoreProgram {
	return {
		functions,
		stringConstants,
		bigintConstants: [],
		literalTemplateData: [],
		sourcePositions: [],
		globalCount: 4,
	};
}

function blockParameter(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
	index = 0,
): CoreValueId {
	return builder.block(block).parameters[index]!.value;
}

function shapedReturn(
	functionIndex: number,
	keyStringIndex: number,
	options: { readonly isAsync?: boolean; readonly isGenerator?: boolean } = {},
): { readonly fn: CoreFunction; readonly object: CoreValueId } {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, options);
	const entry = builder.createBlock();
	const [value] = builder.appendInstruction(entry, "createUndefined", []);
	const [object] = builder.appendInstruction(entry, "createObjectShaped", [value!], {
		attributes: { keyStringIndices: [keyStringIndex] },
	});
	builder.setTerminator(entry, { kind: "return", value: object! });
	return { fn: builder.finish(entry), object: object! };
}

function shapedKeysProgram(
	keyStringIndices: ReadonlyArray<number>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): { readonly program: CoreProgram; readonly object: CoreValueId } {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const values = keyStringIndices.map(
		() => builder.appendInstruction(entry, "createUndefined", [])[0]!,
	);
	const [object] = builder.appendInstruction(entry, "createObjectShaped", values, {
		attributes: { keyStringIndices: [...keyStringIndices] },
	});
	builder.setTerminator(entry, { kind: "return", value: object! });
	return {
		program: coreProgram([builder.finish(entry)], stringConstants),
		object: object!,
	};
}

function functionIndexOfName(program: CoreProgram, name: string): number {
	const found = program.functions.find(
		(fn) =>
			String.fromCodePoint(
				...(program.stringConstants[fn.metadata.nameStringIndex] ?? []),
			) === name,
	);
	expect(found, `no Core function named ${name}`).toBeDefined();
	return found!.functionIndex;
}

function instructions(fn: CoreFunction, opcode: string): ReadonlyArray<CoreInstruction> {
	return fn.blocks
		.flatMap(({ instructions: blockInstructions }) => blockInstructions)
		.filter((instruction) => instruction.opcode === opcode);
}

function replaceInstruction(
	program: CoreProgram,
	functionIndex: number,
	instructionId: number,
	replace: (instruction: CoreInstruction) => CoreInstruction,
): CoreProgram {
	return {
		...program,
		functions: program.functions.map((fn) =>
			fn.functionIndex !== functionIndex
				? fn
				: {
						...fn,
						blocks: fn.blocks.map((block) => ({
							...block,
							instructions: block.instructions.map((instruction) =>
								instruction.id === instructionId ? replace(instruction) : instruction,
							),
						})),
					},
		),
	};
}

function selectKnownOwnSlots(program: CoreProgram) {
	return selectCoreKnownOwnSlots(program, analyzeCoreShapeProvenance(program));
}

function localLoopProgram(): {
	readonly program: CoreProgram;
	readonly load: CoreInstruction;
	readonly loopBlock: CoreBlockId;
} {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const loop = builder.createBlock();
	const latch = builder.createBlock();
	const exit = builder.createBlock();
	const [initial] = builder.appendInstruction(entry, "createUndefined", []);
	const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
		attributes: { keyStringIndices: [1] },
	});
	builder.setTerminator(entry, {
		kind: "jump",
		edge: { block: loop, arguments: [] },
	});
	const [loaded] = builder.appendInstruction(loop, "loadPropertyStatic", [object!], {
		attributes: { stringIndex: 1 },
	});
	const [condition] = builder.appendInstruction(loop, "createBoolean", [], {
		attributes: { value: false },
	});
	builder.setTerminator(loop, {
		kind: "branch",
		condition: condition!,
		consequent: { block: latch, arguments: [] },
		alternate: { block: exit, arguments: [] },
	});
	builder.setTerminator(latch, {
		kind: "jump",
		edge: { block: loop, arguments: [] },
	});
	builder.setTerminator(exit, { kind: "return", value: loaded! });
	const fn = builder.finish(entry);
	return {
		program: coreProgram([fn]),
		load: instructions(fn, "loadPropertyStatic")[0]!,
		loopBlock: loop,
	};
}

function clusteredLoopProgram(): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const loop = builder.createBlock();
	const latch = builder.createBlock();
	const exit = builder.createBlock();
	const values = [1, 2, 3].map(
		(value) =>
			builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value },
			})[0]!,
	);
	const [object] = builder.appendInstruction(entry, "createObjectShaped", values, {
		attributes: { keyStringIndices: [1, 2, 3] },
	});
	builder.setTerminator(entry, { kind: "jump", edge: { block: loop, arguments: [] } });
	const loaded = [1, 2, 3].map(
		(stringIndex) =>
			builder.appendInstruction(loop, "loadPropertyStatic", [object!], {
				attributes: { stringIndex },
			})[0]!,
	);
	const [condition] = builder.appendInstruction(loop, "createBoolean", [], {
		attributes: { value: false },
	});
	builder.setTerminator(loop, {
		kind: "branch",
		condition: condition!,
		consequent: { block: latch, arguments: [] },
		alternate: { block: exit, arguments: [] },
	});
	builder.setTerminator(latch, {
		kind: "jump",
		edge: { block: loop, arguments: [] },
	});
	builder.setTerminator(exit, { kind: "return", value: loaded[2]! });
	return coreProgram([builder.finish(entry)]);
}

function nonLoopClusterProgram(
	options: {
		readonly barrier?: boolean;
		readonly differentCandidate?: boolean;
		readonly movedReceiver?: boolean;
	} = {},
): CoreProgram {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const values = [1, 2].map(
		(value) =>
			builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value },
			})[0]!,
	);
	const [object] = builder.appendInstruction(entry, "createObjectShaped", values, {
		attributes: { keyStringIndices: [1, 2] },
	});
	const [_first] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
		attributes: { stringIndex: 1 },
	});
	if (options.barrier === true) {
		builder.appendInstruction(entry, "createObject", []);
	}
	let secondReceiver = object!;
	if (options.movedReceiver === true) {
		secondReceiver = builder.appendInstruction(entry, "move", [object!])[0]!;
	} else if (options.differentCandidate === true) {
		secondReceiver = builder.appendInstruction(entry, "createObjectShaped", values, {
			attributes: { keyStringIndices: [1, 2] },
		})[0]!;
	}
	const [second] = builder.appendInstruction(
		entry,
		"loadPropertyStatic",
		[secondReceiver],
		{ attributes: { stringIndex: 2 } },
	);
	builder.setTerminator(entry, { kind: "return", value: second! });
	return coreProgram([builder.finish(entry)]);
}

function crossCallProgram(
	producerIndex = 0,
	callerIndex = 1,
): {
	readonly program: CoreProgram;
	readonly load: CoreInstruction;
} {
	const producer = shapedReturn(producerIndex, 1);
	const caller = new CoreFunctionBuilder(callerIndex, coreOpcodeRegistry);
	const entry = caller.createBlock();
	const [thisValue] = caller.appendInstruction(entry, "createUndefined", []);
	const [callee] = caller.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: producerIndex },
	});
	const [object] = caller.appendInstruction(entry, "call", [callee!, thisValue!]);
	const [loaded] = caller.appendInstruction(entry, "loadPropertyStatic", [object!], {
		attributes: { stringIndex: 1 },
	});
	caller.setTerminator(entry, { kind: "return", value: loaded! });
	const callerFunction = caller.finish(entry);
	return {
		program: coreProgram([producer.fn, callerFunction]),
		load: instructions(callerFunction, "loadPropertyStatic")[0]!,
	};
}

function crossCallLoopProgram(): {
	readonly program: CoreProgram;
	readonly load: CoreInstruction;
} {
	const producer = shapedReturn(0, 1);
	const caller = new CoreFunctionBuilder(1, coreOpcodeRegistry);
	const entry = caller.createBlock();
	const loop = caller.createBlock();
	const latch = caller.createBlock();
	const exit = caller.createBlock();
	const [thisValue] = caller.appendInstruction(entry, "createUndefined", []);
	const [callee] = caller.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: 0 },
	});
	const [object] = caller.appendInstruction(entry, "call", [callee!, thisValue!]);
	caller.setTerminator(entry, { kind: "jump", edge: { block: loop, arguments: [] } });
	const [loaded] = caller.appendInstruction(loop, "loadPropertyStatic", [object!], {
		attributes: { stringIndex: 1 },
	});
	const [condition] = caller.appendInstruction(loop, "createBoolean", [], {
		attributes: { value: false },
	});
	caller.setTerminator(loop, {
		kind: "branch",
		condition: condition!,
		consequent: { block: latch, arguments: [] },
		alternate: { block: exit, arguments: [] },
	});
	caller.setTerminator(latch, {
		kind: "jump",
		edge: { block: loop, arguments: [] },
	});
	caller.setTerminator(exit, { kind: "return", value: loaded! });
	const callerFunction = caller.finish(entry);
	return {
		program: coreProgram([producer.fn, callerFunction]),
		load: instructions(callerFunction, "loadPropertyStatic")[0]!,
	};
}

function multiOriginLoopProgram(): {
	readonly program: CoreProgram;
	readonly load: CoreInstruction;
} {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const left = builder.createBlock();
	const right = builder.createBlock();
	const loop = builder.createBlock([{}]);
	const latch = builder.createBlock();
	const exit = builder.createBlock();
	const [initial] = builder.appendInstruction(entry, "createUndefined", []);
	const [first] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
		attributes: { keyStringIndices: [1] },
	});
	const [second] = builder.appendInstruction(
		entry,
		"createObjectShaped",
		[initial!, initial!],
		{
			attributes: { keyStringIndices: [2, 1] },
		},
	);
	const [choose] = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
	});
	builder.setTerminator(entry, {
		kind: "branch",
		condition: choose!,
		consequent: { block: left, arguments: [] },
		alternate: { block: right, arguments: [] },
	});
	builder.setTerminator(left, {
		kind: "jump",
		edge: { block: loop, arguments: [first!] },
	});
	builder.setTerminator(right, {
		kind: "jump",
		edge: { block: loop, arguments: [second!] },
	});
	const receiver = blockParameter(builder, loop);
	const [loaded] = builder.appendInstruction(loop, "loadPropertyStatic", [receiver], {
		attributes: { stringIndex: 1 },
	});
	const [repeat] = builder.appendInstruction(loop, "createBoolean", [], {
		attributes: { value: false },
	});
	builder.setTerminator(loop, {
		kind: "branch",
		condition: repeat!,
		consequent: { block: latch, arguments: [] },
		alternate: { block: exit, arguments: [] },
	});
	builder.setTerminator(latch, {
		kind: "jump",
		edge: { block: loop, arguments: [receiver] },
	});
	builder.setTerminator(exit, { kind: "return", value: loaded! });
	const fn = builder.finish(entry);
	return {
		program: coreProgram([fn]),
		load: instructions(fn, "loadPropertyStatic")[0]!,
	};
}

function aggregateFieldLoopProgram(escaped = false): {
	readonly program: CoreProgram;
	readonly receiver: CoreValueId;
	readonly load: CoreInstruction;
} {
	const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
	const entry = builder.createBlock();
	const loop = builder.createBlock();
	const latch = builder.createBlock();
	const exit = builder.createBlock();
	const [initial] = builder.appendInstruction(entry, "createUndefined", []);
	const [first] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
		attributes: { keyStringIndices: [1] },
	});
	const [second] = builder.appendInstruction(
		entry,
		"createObjectShaped",
		[initial!, initial!],
		{
			attributes: { keyStringIndices: [2, 1] },
		},
	);
	const [holder] = builder.appendInstruction(entry, "createObjectShaped", [first!], {
		attributes: { keyStringIndices: [4] },
	});
	builder.appendInstruction(entry, "storePropertyStatic", [holder!, second!], {
		attributes: { stringIndex: 4 },
	});
	builder.setTerminator(entry, {
		kind: "jump",
		edge: { block: loop, arguments: [] },
	});
	const [receiver] = builder.appendInstruction(loop, "loadPropertyStatic", [holder!], {
		attributes: { stringIndex: 4 },
	});
	const [loaded] = builder.appendInstruction(loop, "loadPropertyStatic", [receiver!], {
		attributes: { stringIndex: 1 },
	});
	const [repeat] = builder.appendInstruction(loop, "createBoolean", [], {
		attributes: { value: false },
	});
	builder.setTerminator(loop, {
		kind: "branch",
		condition: repeat!,
		consequent: { block: latch, arguments: [] },
		alternate: { block: exit, arguments: [] },
	});
	builder.setTerminator(latch, {
		kind: "jump",
		edge: { block: loop, arguments: [] },
	});
	builder.setTerminator(exit, { kind: "return", value: escaped ? holder! : loaded! });
	const fn = builder.finish(entry);
	return {
		program: coreProgram([fn]),
		receiver: receiver!,
		load: instructions(fn, "loadPropertyStatic")[1]!,
	};
}

describe("Core shaped-object provenance", () => {
	it("admits canonical named slots and preserves their original runtime order", () => {
		const { program, object } = shapedKeysProgram([2, 1], [[], [120], [121]]);
		const analysis = analyzeCoreShapeProvenance(program);
		expect(analysis.origins).toHaveLength(1);
		expect(analysis.candidates(0, object)).toEqual({
			origins: [
				expect.objectContaining({
					functionIndex: 0,
					keyStringIndices: [2, 1],
				}),
			],
			opaque: false,
		});
	});

	it("joins shaped values stored in a compiler-created aggregate field", () => {
		const built = aggregateFieldLoopProgram();
		const analysis = analyzeCoreShapeProvenance(built.program);
		expect(
			analysis
				.candidates(0, built.receiver)
				.origins.map(({ keyStringIndices }) => keyStringIndices),
		).toEqual([[1], [2, 1]]);
		expect(analysis.candidates(0, built.receiver).opaque).toBe(false);
		expect(analysis.statistics.aggregateCellNodes).toBeGreaterThan(0);
		const selected = selectCoreKnownOwnSlots(built.program, analysis).program;
		expect(
			coreKnownOwnSlotFromAttribute(
				instructions(selected.functions[0]!, "loadPropertyStatic")[1]!.attributes[
					CORE_KNOWN_OWN_SLOT_ATTRIBUTE
				],
			)?.candidates,
		).toHaveLength(2);

		const escaped = aggregateFieldLoopProgram(true);
		const escapedCandidates = analyzeCoreShapeProvenance(escaped.program).candidates(
			0,
			escaped.receiver,
		);
		expect(escapedCandidates.origins).toHaveLength(2);
		expect(escapedCandidates.opaque).toBe(true);
	});

	it("rejects duplicate-content, array-index, and __proto__ shaped keys", () => {
		const malformed = [
			{
				name: "duplicate-content constants",
				keys: [1, 2],
				strings: [[], [120], [120]],
			},
			{
				name: "canonical array-index string",
				keys: [1],
				strings: [[], [48]],
			},
			{
				name: "literal __proto__ key",
				keys: [1],
				strings: [[], Array.from("__proto__", (character) => character.codePointAt(0)!)],
			},
		] as const;
		for (const { name, keys, strings } of malformed) {
			const { program, object } = shapedKeysProgram(keys, strings);
			const analysis = analyzeCoreShapeProvenance(program);
			expect(analysis.origins, name).toEqual([]);
			expect(analysis.candidates(0, object), name).toEqual({
				origins: [],
				opaque: true,
			});
		}
	});

	it("ignores origins and edges in unreachable blocks", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const unreachable = builder.createBlock();
		const [result] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const [initial] = builder.appendInstruction(unreachable, "createUndefined", []);
		const [object] = builder.appendInstruction(
			unreachable,
			"createObjectShaped",
			[initial!],
			{ attributes: { keyStringIndices: [1] } },
		);
		const [loaded] = builder.appendInstruction(
			unreachable,
			"loadPropertyStatic",
			[object!],
			{ attributes: { stringIndex: 1 } },
		);
		builder.setTerminator(unreachable, { kind: "return", value: loaded! });

		const analysis = analyzeCoreShapeProvenance(coreProgram([builder.finish(entry)]));
		expect(analysis.origins).toHaveLength(0);
		expect(analysis.candidates(0, object!)).toEqual({ origins: [], opaque: false });
	});

	it("opens retained non-executable bodies and rebases executable origins densely", () => {
		const dead = shapedReturn(0, 2).fn;
		const shifted = crossCallProgram(1, 2);
		const program = coreProgram([dead, ...shifted.program.functions]);
		const analysis = analyzeCoreShapeProvenance(program, {
			executableFunctions: new Set([1, 2]),
		});
		expect(
			analysis.candidates(0, instructions(dead, "createObjectShaped")[0]!.outputs[0]!),
		).toEqual({ origins: [], opaque: true });

		const compactedProgram: CoreProgram = {
			...program,
			functions: [
				{ ...program.functions[1]!, functionIndex: 0 },
				{ ...program.functions[2]!, functionIndex: 1 },
			],
		};
		const rebased = rebaseCoreShapeProvenance(
			analysis,
			new Map([
				[1, 0],
				[2, 1],
			]),
			compactedProgram,
		);
		const receiver = shifted.load.inputs[0]!;
		expect(rebased.candidates(1, receiver)).toMatchObject({
			origins: [{ functionIndex: 0, keyStringIndices: [1] }],
		});
	});

	it("relays one allocation through moves, ordinary block arguments, returns, calls, formals, and this", () => {
		const producer = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const producerEntry = producer.createBlock();
		const producerLeft = producer.createBlock();
		const producerRight = producer.createBlock();
		const producerJoin = producer.createBlock([{}]);
		const [initial] = producer.appendInstruction(producerEntry, "createUndefined", []);
		const [object] = producer.appendInstruction(
			producerEntry,
			"createObjectShaped",
			[initial!],
			{ attributes: { keyStringIndices: [1] } },
		);
		const [moved] = producer.appendInstruction(producerEntry, "move", [object!]);
		const [condition] = producer.appendInstruction(producerEntry, "createBoolean", [], {
			attributes: { value: true },
		});
		producer.setTerminator(producerEntry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: producerLeft, arguments: [] },
			alternate: { block: producerRight, arguments: [] },
		});
		producer.setTerminator(producerLeft, {
			kind: "jump",
			edge: { block: producerJoin, arguments: [moved!] },
		});
		producer.setTerminator(producerRight, {
			kind: "jump",
			edge: { block: producerJoin, arguments: [object!] },
		});
		const joined = blockParameter(producer, producerJoin);
		producer.setTerminator(producerJoin, { kind: "return", value: joined });

		const identity = new CoreFunctionBuilder(1, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const identityEntry = identity.createBlock([{}]);
		const identityParameter = blockParameter(identity, identityEntry);
		const [identityMove] = identity.appendInstruction(identityEntry, "move", [
			identityParameter,
		]);
		identity.setTerminator(identityEntry, {
			kind: "return",
			value: identityMove!,
		});

		const consumer = new CoreFunctionBuilder(2, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const consumerEntry = consumer.createBlock([{}]);
		const consumerParameter = blockParameter(consumer, consumerEntry);
		const [thisValue] = consumer.appendInstruction(consumerEntry, "loadThis", []);
		const [parameterValue] = consumer.appendInstruction(
			consumerEntry,
			"loadPropertyStatic",
			[consumerParameter],
			{ attributes: { stringIndex: 1 } },
		);
		consumer.appendInstruction(consumerEntry, "loadPropertyStatic", [thisValue!], {
			attributes: { stringIndex: 1 },
		});
		consumer.setTerminator(consumerEntry, {
			kind: "return",
			value: parameterValue!,
		});

		const caller = new CoreFunctionBuilder(3, coreOpcodeRegistry);
		const callerEntry = caller.createBlock();
		const [undefinedValue] = caller.appendInstruction(callerEntry, "createUndefined", []);
		const [producerFunction] = caller.appendInstruction(
			callerEntry,
			"createFunction",
			[],
			{ attributes: { functionIndex: 0 } },
		);
		const [produced] = caller.appendInstruction(callerEntry, "call", [
			producerFunction!,
			undefinedValue!,
		]);
		const [identityFunction] = caller.appendInstruction(
			callerEntry,
			"createFunction",
			[],
			{ attributes: { functionIndex: 1 } },
		);
		const [relayed] = caller.appendInstruction(callerEntry, "call", [
			identityFunction!,
			undefinedValue!,
			produced!,
		]);
		const [consumerFunction] = caller.appendInstruction(
			callerEntry,
			"createFunction",
			[],
			{ attributes: { functionIndex: 2 } },
		);
		const [consumed] = caller.appendInstruction(callerEntry, "call", [
			consumerFunction!,
			relayed!,
			relayed!,
		]);
		caller.setTerminator(callerEntry, { kind: "return", value: consumed! });

		const analysis = analyzeCoreShapeProvenance(
			coreProgram([
				producer.finish(producerEntry),
				identity.finish(identityEntry),
				consumer.finish(consumerEntry),
				caller.finish(callerEntry),
			]),
		);
		const origin = analysis.candidates(0, object!).origins[0]!;
		expect(origin).toMatchObject({ functionIndex: 0, keyStringIndices: [1] });
		for (const value of [moved!, joined, produced!]) {
			expect(analysis.candidates(value === produced! ? 3 : 0, value)).toEqual({
				origins: [origin],
				opaque: false,
			});
		}
		for (const [functionIndex, value] of [
			[1, identityParameter],
			[3, relayed!],
			[2, consumerParameter],
			[2, thisValue!],
		] as const) {
			expect(analysis.candidates(functionIndex, value)).toEqual({
				origins: [origin],
				opaque: true,
			});
		}
		expect(analysis.statistics.origins).toBe(1);
		expect(analysis.statistics.propagations).toBeLessThanOrEqual(
			analysis.statistics.nodes * (CORE_SHAPE_ORIGIN_CAP + 1),
		);
	});

	it("keeps four guarded candidates and opens a formal when a fifth origin arrives", () => {
		const producers = Array.from({ length: CORE_SHAPE_ORIGIN_CAP + 1 }, (_, index) =>
			shapedReturn(index, index + 1),
		);
		const consumerIndex = producers.length;
		const consumer = new CoreFunctionBuilder(consumerIndex, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const consumerEntry = consumer.createBlock([{}]);
		const parameter = blockParameter(consumer, consumerEntry);
		consumer.setTerminator(consumerEntry, { kind: "return", value: parameter });

		const callerIndex = consumerIndex + 1;
		const caller = new CoreFunctionBuilder(callerIndex, coreOpcodeRegistry);
		const callerEntry = caller.createBlock();
		const [thisValue] = caller.appendInstruction(callerEntry, "createUndefined", []);
		const [consumerFunction] = caller.appendInstruction(
			callerEntry,
			"createFunction",
			[],
			{ attributes: { functionIndex: consumerIndex } },
		);
		let last = thisValue!;
		for (const [index] of producers.entries()) {
			const [producerFunction] = caller.appendInstruction(
				callerEntry,
				"createFunction",
				[],
				{ attributes: { functionIndex: index } },
			);
			const [produced] = caller.appendInstruction(callerEntry, "call", [
				producerFunction!,
				thisValue!,
			]);
			last = caller.appendInstruction(callerEntry, "call", [
				consumerFunction!,
				thisValue!,
				produced!,
			])[0]!;
		}
		caller.setTerminator(callerEntry, { kind: "return", value: last });

		const analysis = analyzeCoreShapeProvenance(
			coreProgram([
				...producers.map(({ fn }) => fn),
				consumer.finish(consumerEntry),
				caller.finish(callerEntry),
			]),
		);
		const candidates = analysis.candidates(consumerIndex, parameter);
		expect(candidates.origins).toHaveLength(CORE_SHAPE_ORIGIN_CAP);
		expect(candidates.origins.map(({ functionIndex }) => functionIndex)).toEqual([
			0, 1, 2, 3,
		]);
		expect(candidates.opaque).toBe(true);
		expect(analysis.statistics.saturatedValues).toBeGreaterThan(0);
	});

	it("relays spread-call results while guarding construct and excluding coroutine results", () => {
		const ordinary = shapedReturn(0, 1);
		const asyncTarget = shapedReturn(1, 2, { isAsync: true });
		const generatorTarget = shapedReturn(2, 3, { isGenerator: true });
		const caller = new CoreFunctionBuilder(3, coreOpcodeRegistry);
		const entry = caller.createBlock();
		const [thisValue] = caller.appendInstruction(entry, "createUndefined", []);
		const [argumentsObject] = caller.appendInstruction(entry, "createArray", [], {
			attributes: { length: 0 },
		});
		const results: Array<CoreValueId> = [];
		for (const [target, opcode] of [
			[0, "construct"],
			[0, "constructSpread"],
			[0, "callSpread"],
			[0, "callSpreadIterable"],
			[1, "call"],
			[2, "call"],
		] as const) {
			const [callee] = caller.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: target },
			});
			const inputs =
				opcode === "construct"
					? [callee!]
					: opcode === "constructSpread"
						? [callee!, argumentsObject!]
						: opcode === "callSpread" || opcode === "callSpreadIterable"
							? [callee!, thisValue!, argumentsObject!]
							: [callee!, thisValue!];
			results.push(caller.appendInstruction(entry, opcode, inputs)[0]!);
		}
		caller.setTerminator(entry, { kind: "return", value: results.at(-1)! });
		const analysis = analyzeCoreShapeProvenance(
			coreProgram([
				ordinary.fn,
				asyncTarget.fn,
				generatorTarget.fn,
				caller.finish(entry),
			]),
		);
		for (const result of results.slice(0, 2)) {
			const constructed = analysis.candidates(3, result);
			expect(constructed.origins).toHaveLength(1);
			expect(constructed.origins[0]!.functionIndex).toBe(0);
			expect(constructed.origins[0]!.keyStringIndices).toEqual([1]);
			expect(constructed.opaque).toBe(true);
		}
		for (const result of results.slice(2, 4)) {
			const called = analysis.candidates(3, result);
			expect(called.origins).toHaveLength(1);
			expect(called.origins[0]!.functionIndex).toBe(0);
			expect(called.origins[0]!.keyStringIndices).toEqual([1]);
			expect(called.opaque).toBe(false);
		}
		for (const result of results.slice(4)) {
			expect(analysis.candidates(3, result)).toEqual({
				origins: [],
				opaque: true,
			});
		}
	});

	it("does not fan constructor argument origins through body formals", () => {
		const program = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run() {
					const Forward = function (value) { return value; };
					return new Forward({ x: 1 });
				}
				run();`,
				"shape-constructor-argument.mjs",
			),
		);
		const owner = program.functions.find(
			(fn) => instructions(fn, "construct").length > 0,
		)!;
		const construct = instructions(owner, "construct")[0]!;
		expect(
			analyzeCoreShapeProvenance(program).candidates(
				owner.functionIndex,
				construct.outputs[0]!,
			),
		).toEqual({ origins: [], opaque: true });
	});

	it("keeps entry, exceptional, compiler-cell, and template alternatives open", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, {
			parameterCount: 1,
		});
		const entry = builder.createBlock([{}]);
		const handler = builder.createBlock([{ role: "exception" }, {}]);
		const parameter = blockParameter(builder, entry);
		const handlerArgument = blockParameter(builder, handler, 1);
		const [initial] = builder.appendInstruction(entry, "createUndefined", []);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
			attributes: { keyStringIndices: [1] },
		});
		builder.appendInstruction(entry, "storeGlobal", [object!], {
			attributes: { index: 0 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [template] = builder.appendInstruction(
			entry,
			"instantiateLiteralTemplate",
			[],
			{
				attributes: { templateOffset: 0 },
			},
		);
		builder.appendInstruction(entry, "loadPropertyStatic", [parameter], {
			attributes: { stringIndex: 1 },
		});
		builder.setHandler(entry, handler, [object!]);
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		builder.setTerminator(handler, { kind: "return", value: handlerArgument });
		const analysis = analyzeCoreShapeProvenance(coreProgram([builder.finish(entry)]));
		for (const value of [parameter, handlerArgument, template!]) {
			expect(analysis.candidates(0, value)).toEqual({
				origins: [],
				opaque: true,
			});
		}
		expect(analysis.candidates(0, loaded!)).toEqual({
			origins: [
				expect.objectContaining({
					functionIndex: 0,
					keyStringIndices: [1],
				}),
			],
			opaque: true,
		});
		expect(analysis.candidates(0, object!).opaque).toBe(false);
	});

	it("relays guarded origins through captured cells across functions", () => {
		const writer = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const writerEntry = writer.createBlock();
		const [initial] = writer.appendInstruction(writerEntry, "createUndefined", []);
		const [object] = writer.appendInstruction(
			writerEntry,
			"createObjectShaped",
			[initial!],
			{ attributes: { keyStringIndices: [1] } },
		);
		writer.appendInstruction(writerEntry, "storeCaptured", [object!], {
			attributes: { functionIndex: 0, index: 3 },
		});
		writer.setTerminator(writerEntry, { kind: "return", value: initial! });

		const reader = new CoreFunctionBuilder(1, coreOpcodeRegistry);
		const readerEntry = reader.createBlock();
		const [loaded] = reader.appendInstruction(readerEntry, "loadCaptured", [], {
			attributes: { functionIndex: 0, index: 3 },
		});
		reader.setTerminator(readerEntry, { kind: "return", value: loaded! });

		const analysis = analyzeCoreShapeProvenance(
			coreProgram([writer.finish(writerEntry), reader.finish(readerEntry)]),
		);
		expect(analysis.candidates(1, loaded!)).toEqual({
			origins: [
				expect.objectContaining({
					functionIndex: 0,
					keyStringIndices: [1],
				}),
			],
			opaque: true,
		});
	});

	it("finds the vector literal at hot parameter loads in a real frontend graph", () => {
		const source = `
			const vector = (x, y, z) => ({ x, y, z });
			const add = (left, right) => vector(
				left.x + right.x,
				left.y + right.y,
				left.z + right.z
			);
			const scale = (value, factor) => vector(
				value.x * factor,
				value.y * factor,
				value.z * factor
			);
			const dot = (left, right) =>
				left.x * right.x + left.y * right.y + left.z * right.z;
			function run() {
				const first = vector(1, 2, 3);
				const second = scale(first, 0.5);
				return dot(add(first, second), second);
			}
			run();
		`;
		const program = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(source, "shape-vector.mjs"),
		);
		const analysis = analyzeCoreShapeProvenance(program);
		const vectorIndex = functionIndexOfName(program, "vector");
		const vectorOrigin = analysis.origins.find(
			({ functionIndex }) => functionIndex === vectorIndex,
		);
		expect(vectorOrigin).toBeDefined();
		expect(vectorOrigin!.keyStringIndices).toHaveLength(3);

		let candidateLoads = 0;
		for (const name of ["scale", "dot"]) {
			const functionIndex = functionIndexOfName(program, name);
			const fn = program.functions[functionIndex]!;
			for (const load of instructions(fn, "loadProperty")) {
				const receiver = load.inputs[0]!;
				const candidates = analysis.candidates(functionIndex, receiver);
				if (candidates.origins.includes(vectorOrigin!)) candidateLoads++;
			}
		}
		expect(candidateLoads).toBeGreaterThanOrEqual(9);
	});
});

describe("Core known own-slot selection", () => {
	it("precompiles plain object-method literals and consumes their receiver shape", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count) {
					const object = {
						x: 6,
						read(innerCount) {
							let total = 0;
							for (let index = 0; index < innerCount; index++) total += this.x;
							return total;
						},
					};
					return object.read(count);
				}
				run(4);`,
				"shape-object-method-receiver.mjs",
			),
		);
		const shaped = initial.functions
			.flatMap((fn) => instructions(fn, "createObjectShaped"))
			.at(0);
		expect(shaped?.attributes.keyStringIndices).toEqual([
			initial.stringConstants.findIndex(
				(value) => String.fromCodePoint(...value) === "x",
			),
			initial.stringConstants.findIndex(
				(value) => String.fromCodePoint(...value) === "read",
			),
		]);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const read = optimized.functions[functionIndexOfName(optimized, "read")]!;
		expect(
			instructions(read, "loadPropertyStatic").some(
				(instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes,
			),
		).toBe(true);
		expect(read.metadata.hasPrototype).toBe(false);
	});

	it("publishes guarded loop loads through both spread-call forms", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count) {
					const Factory = function (value) { return { x: value }; };
					const iterable = Factory(...[2]);
					const packed = Factory(3, ...[]);
					let total = 0;
					for (let index = 0; index < count; index++) total += iterable.x + packed.x;
					return total;
				}
				run(4);`,
				"shape-spread-call-return-relay.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		for (const opcode of ["callSpread", "callSpreadIterable"] as const) {
			const call = optimized.functions.flatMap((fn) => instructions(fn, opcode)).at(0);
			expect(call).toBeDefined();
			const owner = optimized.functions.find((fn) =>
				fn.blocks.some((block) => block.instructions.includes(call!)),
			)!;
			expect(
				analyzeCoreShapeProvenance(optimized).candidates(
					owner.functionIndex,
					call!.outputs[0]!,
				).origins,
			).toHaveLength(1);
		}
		expect(
			optimized.functions
				.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
				.filter((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes),
		).toHaveLength(2);
	});

	it("publishes a guarded loop load through explicit constructor object completion", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count) {
					const Factory = function (value) { return { x: value }; };
					const constructed = new Factory(2);
					let total = 0;
					for (let index = 0; index < count; index++) total += constructed.x;
					return total;
				}
				run(4);`,
				"shape-constructor-return-relay.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const construct = optimized.functions
			.flatMap((fn) => instructions(fn, "construct"))
			.at(0);
		expect(construct).toBeDefined();
		const owner = optimized.functions.find((fn) =>
			fn.blocks.some((block) => block.instructions.includes(construct!)),
		)!;
		const result = analyzeCoreShapeProvenance(optimized).candidates(
			owner.functionIndex,
			construct!.outputs[0]!,
		);
		expect(result.opaque).toBe(true);
		expect(result.origins).toHaveLength(1);
		expect(
			optimized.functions
				.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
				.some((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes),
		).toBe(true);
	});

	it("precompiles a synthetic receiver layout for an exact constructor", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count) {
					function Point(x, y) { this.x = x; this.y = y; }
					const point = new Point(2, 3);
					let total = 0;
					for (let index = 0; index < count; index++) total += point.x + point.y;
					return total;
				}
				run(4);`,
				"shape-constructor-layout.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const construct = optimized.functions
			.flatMap((fn) => instructions(fn, "construct"))
			.at(0)!;
		const owner = optimized.functions.find((fn) =>
			fn.blocks.some((block) => block.instructions.includes(construct)),
		)!;
		const result = analyzeCoreShapeProvenance(optimized).candidates(
			owner.functionIndex,
			construct.outputs[0]!,
		);
		expect(result.opaque).toBe(true);
		expect(result.origins).toHaveLength(1);
		expect(result.origins[0]).toMatchObject({ kind: "constructor" });
		expect(result.origins[0]!.keyStringIndices).toHaveLength(2);
		const origin = result.origins[0]!;
		const guarded = optimized.functions
			.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
			.filter((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes);
		expect(guarded).toHaveLength(2);
		for (const instruction of guarded) {
			expect(
				coreKnownOwnSlotFromAttribute(
					instruction.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
				)?.candidates,
			).toEqual([
				expect.objectContaining({
					shapeFunctionIndex: origin.functionIndex,
					shapeInstruction: origin.instruction,
				}),
			]);
		}
		const secondStore = instructions(
			optimized.functions[origin.functionIndex]!,
			"storePropertyStatic",
		)[1]!;
		const forgedAnchor = replaceInstruction(
			optimized,
			owner.functionIndex,
			guarded[0]!.id,
			(instruction) => ({
				...instruction,
				attributes: {
					...instruction.attributes,
					[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]: {
						candidates: [
							{
								shapeFunctionIndex: origin.functionIndex,
								shapeInstruction: secondStore.id,
								slot: 0,
							},
						],
					},
				},
			}),
		);
		expect(() => verifyCoreProgram(forgedAnchor, coreOpcodeRegistry)).toThrow(
			"invalid shaped-object origin",
		);

		const vm = lowerExecutionToProgramImage(
			lowerCoreCompilationToExecution(coreCompilationForTest(optimized)),
		);
		const descriptor = vm.runtime.precompiledLiteralShapes.find(
			(shape) => shape.functionIndex === origin.functionIndex,
		);
		expect(descriptor?.keyStringIndices).toEqual(origin.keyStringIndices);
		expect(vm.runtime.functions[origin.functionIndex]!.literalShapeCount).toBe(1);
		expect(
			vm.runtime.functions[origin.functionIndex]!.instructions.some(
				(instruction) => instruction.opcode === "CREATE_OBJECT_SHAPED",
			),
		).toBe(false);
		expect(
			vm.runtime.functions
				.flatMap((fn) => fn.instructions)
				.filter((instruction) => instruction.opcode.includes("KNOWN_OWN_SLOT")),
		).toHaveLength(2);
	});

	it("propagates base-class public field layouts and rejects unstable fields", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count, leak) {
					class Point { x = 2; y = 3; }
					class Escaped { x = leak(this); }
					class Private { #x = 1; read() { return this.#x; } }
					class Derived extends Point { z = 4; }
					const point = new Point();
					new Escaped(); new Private(); new Derived();
					let total = 0;
					for (let index = 0; index < count; index++) total += point.x + point.y;
					return total;
				}
				run(4, () => 0);`,
				"shape-class-field-layout.mjs",
			),
		);
		const point = initial.functions[functionIndexOfName(initial, "Point")]!;
		const layout = coreConstructorShapeLayout(initial, point);
		expect(layout?.keyStringIndices).toHaveLength(2);
		expect(instructions(point, "defineProperty")).toHaveLength(2);
		for (const name of ["Escaped", "Private", "Derived"]) {
			expect(
				coreConstructorShapeLayout(
					initial,
					initial.functions[functionIndexOfName(initial, name)]!,
				),
				name,
			).toBeUndefined();
		}

		const firstField = instructions(point, "defineProperty")[0]!;
		const invalidDescriptor = replaceInstruction(
			initial,
			point.functionIndex,
			firstField.id,
			(instruction) => ({
				...instruction,
				attributes: { ...instruction.attributes, configurable: false },
			}),
		);
		expect(
			coreConstructorShapeLayout(
				invalidDescriptor,
				invalidDescriptor.functions[point.functionIndex]!,
			),
		).toBeUndefined();

		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const guarded = optimized.functions
			.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
			.filter((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes);
		expect(guarded).toHaveLength(2);
		const optimizedPoint = optimized.functions[functionIndexOfName(optimized, "Point")]!;
		const optimizedField = instructions(optimizedPoint, "defineProperty")[0]!;
		const forgedDescriptor = replaceInstruction(
			optimized,
			optimizedPoint.functionIndex,
			optimizedField.id,
			(instruction) => ({
				...instruction,
				attributes: { ...instruction.attributes, configurable: false },
			}),
		);
		expect(() => verifyCoreProgram(forgedDescriptor, coreOpcodeRegistry)).toThrow(
			"invalid shaped-object origin",
		);
		const classOrigins = analyzeCoreShapeProvenance(optimized).origins.filter(
			({ kind, functionIndex }) =>
				kind === "constructor" &&
				functionIndex === functionIndexOfName(optimized, "Point"),
		);
		expect(classOrigins).toHaveLength(1);
	});

	it("joins bounded constructor layouts and excludes unstable constructor bodies", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count, second, touch) {
					function First(value) { this.x = value; }
					function Second(value) { this.tag = "second"; this.x = value; }
					function Escaped(value) { this.x = value; touch(this); }
					function Branched(value) { if (value) this.x = value; }
					function Returning(value) { this.x = value; return { x: value + 1 }; }
					const Constructor = second ? Second : First;
					const object = new Constructor(2);
					new Escaped(1); new Branched(1); new Returning(1);
					let total = 0;
					for (let index = 0; index < count; index++) total += object.x;
					return total;
				}
				run(4, false, () => {});`,
				"shape-constructor-layout-boundaries.mjs",
			),
		);
		for (const name of ["Escaped", "Branched", "Returning"]) {
			const fn = initial.functions[functionIndexOfName(initial, name)]!;
			expect(coreConstructorShapeLayout(initial, fn), name).toBeUndefined();
		}
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const guarded = optimized.functions
			.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
			.find((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes)!;
		expect(guarded).toBeDefined();
		const claim = coreKnownOwnSlotFromAttribute(
			guarded.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
		);
		expect(claim?.candidates).toHaveLength(2);
		const owner = optimized.functions.find((fn) =>
			fn.blocks.some((block) => block.instructions.includes(guarded)),
		)!;
		const construct = instructions(owner, "construct").find(
			(instruction) => instruction.outputs[0] === guarded.inputs[0],
		)!;
		const candidates = analyzeCoreShapeProvenance(optimized).candidates(
			owner.functionIndex,
			construct.outputs[0]!,
		);
		expect(candidates.origins.filter(({ kind }) => kind === "constructor")).toHaveLength(
			2,
		);
		expect(candidates.opaque).toBe(true);
	});

	it("publishes a guarded loop load through Function.prototype.call argument relay", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count) {
					const identity = (value) => value;
					const object = { x: 2 };
					const relayed = identity.call(null, object);
					let total = 0;
					for (let index = 0; index < count; index++) total += relayed.x;
					return total;
				}
				run(4);`,
				"shape-function-call-relay.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const flattenedCall = optimized.functions
			.flatMap((fn) => instructions(fn, "call"))
			.find((instruction) => instruction.attributes.directFunctionCall === true);
		expect(flattenedCall).toBeDefined();
		const owner = optimized.functions.find((fn) =>
			fn.blocks.some((block) => block.instructions.includes(flattenedCall!)),
		)!;
		const analysis = analyzeCoreShapeProvenance(optimized);
		const guardedLoad = optimized.functions
			.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
			.find((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes);
		expect(guardedLoad).toBeDefined();
		const result = analysis.candidates(owner.functionIndex, flattenedCall!.outputs[0]!);
		expect(result.opaque).toBe(true);
		expect(result.origins).toHaveLength(1);
		expect(result.origins[0]!.keyStringIndices).toHaveLength(1);
	});

	it("selects a local loop load and is identity-idempotent", () => {
		const built = localLoopProgram();
		const first = selectKnownOwnSlots(built.program);
		expect(first.changed).toBe(true);
		const selectedLoad = instructions(
			first.program.functions[0]!,
			"loadPropertyStatic",
		)[0]!;
		const claim = coreKnownOwnSlotFromAttribute(
			selectedLoad.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
		);
		expect(claim?.candidates).toEqual([
			expect.objectContaining({ shapeFunctionIndex: 0, slot: 0 }),
		]);
		expect(
			instructions(first.program.functions[0]!, "createObjectShaped").some(
				({ id }) => id === claim?.candidates[0]?.shapeInstruction,
			),
		).toBe(true);

		const second = selectKnownOwnSlots(first.program);
		expect(second.changed).toBe(false);
		expect(second.program).toBe(first.program);
		expect(instructions(second.program.functions[0]!, "loadPropertyStatic")[0]).toBe(
			selectedLoad,
		);
	});

	it("keeps cross-call provenance but declines an acyclic output site", () => {
		const built = crossCallProgram();
		const analysis = analyzeCoreShapeProvenance(built.program);
		expect(analysis.candidates(1, built.load.inputs[0]!).origins).toHaveLength(1);
		const selected = selectKnownOwnSlots(built.program);
		expect(selected.changed).toBe(false);
		expect(CORE_KNOWN_OWN_SLOT_ATTRIBUTE in built.load.attributes).toBe(false);
	});

	it("selects a cross-call origin when the consumer load repeats in a loop", () => {
		const built = crossCallLoopProgram();
		const selected = selectKnownOwnSlots(built.program);
		const load = instructions(selected.program.functions[1]!, "loadPropertyStatic")[0]!;
		expect(
			coreKnownOwnSlotFromAttribute(load.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]),
		).toMatchObject({ candidates: [{ shapeFunctionIndex: 0, slot: 0 }] });
	});

	it("retracts published hints once and preserves every unrelated identity", () => {
		const selected = selectKnownOwnSlots(crossCallLoopProgram().program).program;
		const previousProducer = selected.functions[0]!;
		const previousCaller = selected.functions[1]!;
		const previousEpoch = previousCaller.mutationEpoch;
		const first = retractCoreKnownOwnSlots(selected);
		expect(first.changed).toBe(true);
		expect(first.program.functions[0]).toBe(previousProducer);
		expect(first.program.functions[1]!.mutationEpoch).toBe(previousEpoch + 1);
		expect(
			CORE_KNOWN_OWN_SLOT_ATTRIBUTE in
				instructions(first.program.functions[1]!, "loadPropertyStatic")[0]!.attributes,
		).toBe(false);

		const second = retractCoreKnownOwnSlots(first.program);
		expect(second.changed).toBe(false);
		expect(second.program).toBe(first.program);
	});

	it("declines a non-loop local load", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [initial] = builder.appendInstruction(entry, "createUndefined", []);
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [initial!], {
			attributes: { keyStringIndices: [1] },
		});
		builder.appendInstruction(entry, "storePropertyStatic", [object!, initial!], {
			attributes: { stringIndex: 1 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const program = coreProgram([builder.finish(entry)]);
		const selected = selectKnownOwnSlots(program);
		expect(selected.changed).toBe(false);
		expect(selected.program).toBe(program);
		expect(
			CORE_KNOWN_OWN_SLOT_ATTRIBUTE in
				instructions(program.functions[0]!, "loadPropertyStatic")[0]!.attributes,
		).toBe(false);
		expect(
			CORE_KNOWN_OWN_SLOT_ATTRIBUTE in
				instructions(program.functions[0]!, "storePropertyStatic")[0]!.attributes,
		).toBe(false);
	});

	it("shares one shape selection across two safe non-loop loads", () => {
		const initial = nonLoopClusterProgram();
		const selected = selectKnownOwnSlots(initial);
		expect(selected.changed).toBe(true);
		const fn = selected.program.functions[0]!;
		expect(instructions(fn, "selectShapeCase")).toHaveLength(1);
		expect(instructions(fn, "loadPropertyStaticShapeCase")).toHaveLength(2);
		expect(instructions(fn, "loadPropertyStatic")).toHaveLength(0);
		expect(
			fn.blocks.flatMap(({ instructions: blockInstructions }) =>
				blockInstructions.filter(
					(instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes,
				),
			),
		).toHaveLength(0);
		verifyCoreProgram(selected.program, coreOpcodeRegistry);

		const rerun = selectKnownOwnSlots(selected.program);
		expect(rerun.changed).toBe(false);
		expect(rerun.program).toBe(selected.program);
	});

	it("keeps unsafe or mismatched non-loop load pairs generic", () => {
		for (const initial of [
			nonLoopClusterProgram({ barrier: true }),
			nonLoopClusterProgram({ movedReceiver: true }),
			nonLoopClusterProgram({ differentCandidate: true }),
		]) {
			const selected = selectKnownOwnSlots(initial);
			expect(selected.changed).toBe(false);
			expect(selected.program).toBe(initial);
			expect(instructions(initial.functions[0]!, "selectShapeCase")).toHaveLength(0);
			expect(instructions(initial.functions[0]!, "loadPropertyStatic")).toHaveLength(2);
			expect(
				instructions(initial.functions[0]!, "loadPropertyStatic").some(
					(instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes,
				),
			).toBe(false);
		}
	});

	it("selects each distinct bounded layout for multiple guarded origins", () => {
		const built = multiOriginLoopProgram();
		const origins = analyzeCoreShapeProvenance(built.program).origins;
		expect(origins).toHaveLength(2);
		const selected = selectKnownOwnSlots(built.program);
		expect(selected.changed).toBe(true);
		const load = instructions(selected.program.functions[0]!, "loadPropertyStatic")[0]!;
		expect(
			coreKnownOwnSlotFromAttribute(load.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE])
				?.candidates,
		).toEqual([
			{
				shapeFunctionIndex: 0,
				shapeInstruction: origins[0]!.instruction,
				slot: 0,
			},
			{
				shapeFunctionIndex: 0,
				shapeInstruction: origins[1]!.instruction,
				slot: 1,
			},
		]);
		const rerun = selectKnownOwnSlots(selected.program);
		expect(rerun.changed).toBe(false);
		expect(rerun.program).toBe(selected.program);
	});

	it("retracts a candidate when a region claims the load", () => {
		const built = localLoopProgram();
		const selected = selectKnownOwnSlots(built.program).program;
		const fn = selected.functions[0]!;
		const claimed: CoreFunction = {
			...fn,
			regions: [
				{
					kind: "test-known-own-slot-conflict",
					anchors: [built.load.id],
					claimedInstructions: [built.load.id],
					ordinaryBlocks: [built.loopBlock],
					exceptionalBlocks: [],
					data: {},
				},
			],
		};
		const regionProgram: CoreProgram = {
			...selected,
			functions: [claimed],
		};
		expect(() => verifyCoreProgram(regionProgram, coreOpcodeRegistry)).toThrow(
			"claimed by both a Core region and a known own slot",
		);
		const retracted = selectKnownOwnSlots(regionProgram);
		expect(retracted.changed).toBe(true);
		expect(
			CORE_KNOWN_OWN_SLOT_ATTRIBUTE in
				instructions(retracted.program.functions[0]!, "loadPropertyStatic")[0]!
					.attributes,
		).toBe(false);
	});

	it("rejects malformed and structurally invalid certificates", () => {
		const built = crossCallLoopProgram();
		const selected = selectKnownOwnSlots(built.program).program;
		expect(() => verifyCoreProgram(selected, coreOpcodeRegistry)).not.toThrow();
		const load = instructions(selected.functions[1]!, "loadPropertyStatic")[0]!;
		const valid = coreKnownOwnSlotFromAttribute(
			load.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
		)!;
		const validCandidate = valid.candidates[0]!;
		const validValue = {
			candidates: valid.candidates.map((candidate) => ({ ...candidate })),
		};
		for (const value of [
			undefined,
			{ candidates: [] },
			{ candidates: [{ ...validCandidate }, { ...validCandidate }] },
			{ candidates: Array.from({ length: 5 }, () => ({ ...validCandidate })) },
			{ candidates: [{ ...validCandidate, slot: -0 }] },
			{ ...validValue, extra: 1 },
		] as const) {
			const malformed = replaceInstruction(selected, 1, load.id, (instruction) => ({
				...instruction,
				attributes: {
					...instruction.attributes,
					[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]: value,
				},
			}));
			expect(() => verifyCoreProgram(malformed, coreOpcodeRegistry)).toThrow(
				"invalid known own slot",
			);
		}

		for (const value of [
			{ candidates: [{ ...validCandidate, shapeFunctionIndex: 99 }] },
			{
				candidates: [{ ...validCandidate, shapeInstruction: coreInstructionId(99_999) }],
			},
			{ candidates: [{ ...validCandidate, slot: 1 }] },
		] as const) {
			const malformed = replaceInstruction(selected, 1, load.id, (instruction) => ({
				...instruction,
				attributes: {
					...instruction.attributes,
					[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]: value,
				},
			}));
			expect(() => verifyCoreProgram(malformed, coreOpcodeRegistry)).toThrow(
				/invalid shaped-object origin|different static key/,
			);
		}

		const nonLoad = selected.functions[1]!.blocks.flatMap(
			({ instructions: blockInstructions }) => blockInstructions,
		).find(({ opcode }) => opcode === "createUndefined")!;
		const misplaced = replaceInstruction(selected, 1, nonLoad.id, (instruction) => ({
			...instruction,
			attributes: {
				...instruction.attributes,
				[CORE_KNOWN_OWN_SLOT_ATTRIBUTE]: validValue,
			},
		}));
		expect(() => verifyCoreProgram(misplaced, coreOpcodeRegistry)).toThrow(
			"known own slot on createUndefined",
		);
	});

	it("rejects certificates backed by malformed shaped-object origins", () => {
		const selected = selectKnownOwnSlots(crossCallLoopProgram().program).program;
		const origin = instructions(selected.functions[0]!, "createObjectShaped")[0]!;
		const duplicateStringIndex = selected.stringConstants.length;
		const duplicateKeyProgram = replaceInstruction(
			{
				...selected,
				stringConstants: [...selected.stringConstants, [...selected.stringConstants[1]!]],
			},
			0,
			origin.id,
			(instruction) => ({
				...instruction,
				inputs: [instruction.inputs[0]!, instruction.inputs[0]!],
				attributes: {
					...instruction.attributes,
					keyStringIndices: [1, duplicateStringIndex],
				},
			}),
		);
		expect(() => verifyCoreProgram(duplicateKeyProgram, coreOpcodeRegistry)).toThrow(
			"invalid shaped-object origin",
		);

		const mismatchedArityProgram = replaceInstruction(
			selected,
			0,
			origin.id,
			(instruction) => ({
				...instruction,
				attributes: {
					...instruction.attributes,
					keyStringIndices: [1, 2],
				},
			}),
		);
		expect(() => verifyCoreProgram(mismatchedArityProgram, coreOpcodeRegistry)).toThrow(
			"invalid shaped-object origin",
		);
	});

	it("shares one exact shape case across a bounded static-load cluster", () => {
		const initial = clusteredLoopProgram();
		const selected = selectKnownOwnSlots(initial).program;
		verifyCoreProgram(selected, coreOpcodeRegistry);
		const fn = selected.functions[0]!;
		const [selector] = instructions(fn, "selectShapeCase");
		const loads = instructions(fn, "loadPropertyStaticShapeCase");
		expect(selector).toBeDefined();
		expect(selector!.outputs).toHaveLength(1);
		expect(selector!.attributes[CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE]).toEqual([
			{ shapeFunctionIndex: 0, shapeInstruction: 3 },
		]);
		expect(loads).toHaveLength(3);
		expect(loads.map(({ inputs }) => inputs[1])).toEqual([
			selector!.outputs[0],
			selector!.outputs[0],
			selector!.outputs[0],
		]);
		expect(
			loads.map(({ attributes }) => attributes[CORE_SHAPE_CASE_SLOTS_ATTRIBUTE]),
		).toEqual([[0], [1], [2]]);
		expect(instructions(fn, "loadPropertyStatic")).toHaveLength(0);

		const retracted = retractCoreKnownOwnSlots(selected);
		expect(retracted.changed).toBe(true);
		expect(instructions(retracted.program.functions[0]!, "selectShapeCase")).toHaveLength(
			0,
		);
		expect(
			instructions(retracted.program.functions[0]!, "loadPropertyStatic"),
		).toHaveLength(3);
		verifyCoreProgram(retracted.program, coreOpcodeRegistry);

		const rerun = selectKnownOwnSlots(selected);
		expect(rerun.program).toEqual(selected);
	});

	it("rejects a clustered shape slot that names a different key", () => {
		const selected = selectKnownOwnSlots(clusteredLoopProgram()).program;
		const load = instructions(selected.functions[0]!, "loadPropertyStaticShapeCase")[1]!;
		const malformed = replaceInstruction(selected, 0, load.id, (instruction) => ({
			...instruction,
			attributes: {
				...instruction.attributes,
				[CORE_SHAPE_CASE_SLOTS_ATTRIBUTE]: [0],
			},
		}));
		expect(() => verifyCoreProgram(malformed, coreOpcodeRegistry)).toThrow(
			"shape-case slot for a different static key",
		);

		const orphan = replaceInstruction(selected, 0, load.id, (instruction) => ({
			...instruction,
			inputs: [instruction.inputs[0]!, instruction.inputs[0]!],
		}));
		expect(() => verifyCoreProgram(orphan, coreOpcodeRegistry)).toThrow(
			"has no shape-case selector",
		);

		const misplaced = replaceInstruction(selected, 0, load.id, (instruction) => ({
			...instruction,
			attributes: {
				...instruction.attributes,
				[CORE_SHAPE_CASE_CANDIDATES_ATTRIBUTE]: [
					{ shapeFunctionIndex: 0, shapeInstruction: 3 },
				],
			},
		}));
		expect(() => verifyCoreProgram(misplaced, coreOpcodeRegistry)).toThrow(
			"carries shape-case candidates on loadPropertyStaticShapeCase",
		);
	});

	it("lowers an interprocedural loop cluster to one portable shape case", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(count) {
					const object = {
						x: 1, y: 2, z: 3,
						sum3(innerCount) {
							let total = 0;
							for (let index = 0; index < innerCount; index++) {
								const x = this.x;
								const y = this.y;
								const z = this.z;
								total += x + y + z;
							}
							return total;
						},
					};
					return object.sum3(count);
				}
				run(10);`,
				"shape-case-target.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const coreSelectors = optimized.functions.flatMap((fn) =>
			instructions(fn, "selectShapeCase"),
		);
		const coreLoads = optimized.functions.flatMap((fn) =>
			instructions(fn, "loadPropertyStaticShapeCase"),
		);
		expect(coreSelectors).toHaveLength(1);
		expect(coreLoads).toHaveLength(3);

		const target = lowerCoreCompilationToExecution(coreCompilationForTest(optimized));
		const targetInstructions = target.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions: blockInstructions }) => blockInstructions);
		expect(
			targetInstructions.filter(({ type }) => type === "selectShapeCase"),
		).toHaveLength(1);
		expect(
			targetInstructions.filter(({ type }) => type === "loadPropertyStaticShapeCase"),
		).toHaveLength(3);
		const vm = lowerExecutionToProgramImage(target);
		const vmSelectors = vm.runtime.functions.flatMap(({ instructions }) =>
			instructions.filter(({ opcode }) => opcode === "SELECT_SHAPE_CASE"),
		);
		const vmLoads = vm.runtime.functions.flatMap(({ instructions }) =>
			instructions.filter(({ opcode }) => opcode === "LOAD_PROPERTY_STATIC_SHAPE_CASE"),
		);
		expect(vmSelectors).toHaveLength(1);
		expect(vmLoads).toHaveLength(3);
	});

	it("lowers two acyclic loads to one portable shape case", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function run(touch) {
					const object = {
						x: 1,
						y: 2,
						sum2() {
							touch(this);
							const x = this.x;
							const y = this.y;
							return x + y;
						},
					};
					return object.sum2();
				}
				run(() => {});`,
				"shape-case-non-loop-target.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining"]),
		}).program;
		const coreSelectors = optimized.functions.flatMap((fn) =>
			instructions(fn, "selectShapeCase"),
		);
		const coreLoads = optimized.functions.flatMap((fn) =>
			instructions(fn, "loadPropertyStaticShapeCase"),
		);
		expect(coreSelectors).toHaveLength(1);
		expect(coreLoads).toHaveLength(2);
		expect(
			optimized.functions
				.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
				.some((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes),
		).toBe(false);

		const target = lowerCoreCompilationToExecution(coreCompilationForTest(optimized));
		const targetInstructions = target.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions: blockInstructions }) => blockInstructions);
		expect(
			targetInstructions.filter(({ type }) => type === "selectShapeCase"),
		).toHaveLength(1);
		expect(
			targetInstructions.filter(({ type }) => type === "loadPropertyStaticShapeCase"),
		).toHaveLength(2);
		const vm = lowerExecutionToProgramImage(target);
		expect(
			vm.runtime.functions.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "SELECT_SHAPE_CASE"),
			),
		).toHaveLength(1);
		expect(
			vm.runtime.functions.flatMap(({ instructions }) =>
				instructions.filter(({ opcode }) => opcode === "LOAD_PROPERTY_STATIC_SHAPE_CASE"),
			),
		).toHaveLength(2);
	});

	it("carries the certificate unchanged to the target load", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function read(n, touch) {
					const object = { x: n };
					let sum = 0;
					for (let index = 0; index < n; index++) {
						touch(object);
						sum += object.x;
					}
					return sum;
				}
				read(3, () => {});`,
				"known-own-slot-target.mjs",
			),
		);
		const optimizationOptions: CoreOptimizationOptions = {
			ablations: new Set(["inlining", "interprocedural"]),
		};
		const optimized = executeCoreOptimizations(initial, optimizationOptions).program;
		const coreLoad = optimized.functions
			.flatMap((fn) => instructions(fn, "loadPropertyStatic"))
			.find((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes)!;
		expect(coreLoad).toBeDefined();
		const target = lowerCoreCompilationToExecution(coreCompilationForTest(optimized));
		const targetLoad = target.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions: blockInstructions }) => blockInstructions)
			.find(
				(instruction) =>
					instruction.type === "loadPropertyStatic" &&
					instruction.knownOwnSlot !== undefined,
			);
		expect(targetLoad?.type).toBe("loadPropertyStatic");
		if (targetLoad?.type !== "loadPropertyStatic") return;
		expect(targetLoad.knownOwnSlot).toEqual(
			coreLoad.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
		);

		const rerun = executeCoreOptimizations(optimized, optimizationOptions).program;
		expect(
			lowerCoreCompilationToExecution(coreCompilationForTest(rerun)).functions,
		).toEqual(target.functions);
	});

	it("carries a loop store certificate unchanged to the target", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function write(n, touch) {
					const object = { x: 0 };
					for (let index = 0; index < n; index++) {
						touch(object);
						object.x = index;
					}
					return object.x;
				}
				write(3, () => {});`,
				"known-own-slot-store-target.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining", "interprocedural"]),
		}).program;
		const coreStore = optimized.functions
			.flatMap((fn) => instructions(fn, "storePropertyStatic"))
			.find((instruction) => CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes)!;
		expect(coreStore).toBeDefined();
		const target = lowerCoreCompilationToExecution(coreCompilationForTest(optimized));
		const targetStore = target.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions: blockInstructions }) => blockInstructions)
			.find(
				(instruction) =>
					instruction.type === "storePropertyStatic" &&
					instruction.knownOwnSlot !== undefined,
			);
		expect(targetStore?.type).toBe("storePropertyStatic");
		if (targetStore?.type !== "storePropertyStatic") return;
		expect(targetStore.knownOwnSlot).toEqual(
			coreStore.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
		);
	});

	it("publishes a guarded loop load from a captured finite shape set", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function exercise(second) {
					let state;
					if (second) state = { x: 1 };
					else state = { x: 2 };
					function sum() {
						let total = 0;
						for (let index = 0; index < 4; index++) total += state.x;
						return total;
					}
					return sum();
				}
				exercise(false);`,
				"captured-known-own-slot.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial).program;
		const selected = optimized.functions
			.flatMap((fn) =>
				fn.blocks.flatMap((block) =>
					block.instructions.map((instruction) => ({ fn, instruction })),
				),
			)
			.find(
				({ instruction }) =>
					instruction.opcode === "loadPropertyStatic" &&
					CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes,
			);
		expect(selected).toBeDefined();
		const receiver = selected!.instruction.inputs[0]!;
		const candidates = analyzeCoreShapeProvenance(optimized).candidates(
			selected!.fn.functionIndex,
			receiver,
		);
		expect(candidates.origins).toHaveLength(2);
		expect(candidates.opaque).toBe(true);
		expect(instructions(selected!.fn, "loadCaptured")).not.toHaveLength(0);
	});

	it("propagates stored shapes through an escaped aggregate field", () => {
		const initial = lowerSemanticProgramToCore(
			analyzeSourceAndRunSemanticAnalysis(
				`function exercise(second) {
					const holder = { value: { x: 1 } };
					if (second) holder.value = { tag: "second", x: 2 };
					globalThis.publishHolder(holder);
					let total = 0;
					for (let index = 0; index < 4; index++) total += holder.value.x;
					return total;
				}
				exercise(false);`,
				"aggregate-known-own-slot.mjs",
			),
		);
		const optimized = executeCoreOptimizations(initial, {
			ablations: new Set(["inlining", "interprocedural"]),
		}).program;
		const selected = optimized.functions
			.flatMap((fn) =>
				fn.blocks.flatMap((block) =>
					block.instructions.map((instruction) => ({ fn, instruction })),
				),
			)
			.find(
				({ instruction }) =>
					instruction.opcode === "loadPropertyStatic" &&
					CORE_KNOWN_OWN_SLOT_ATTRIBUTE in instruction.attributes,
			);
		expect(selected).toBeDefined();
		const analysis = analyzeCoreShapeProvenance(optimized);
		const candidates = analysis.candidates(
			selected!.fn.functionIndex,
			selected!.instruction.inputs[0]!,
		);
		expect(
			candidates.origins.map(({ keyStringIndices }) => keyStringIndices.length),
		).toEqual([1]);
		expect(analysis.statistics.aggregateCellNodes).toBeGreaterThan(0);
		expect(
			coreKnownOwnSlotFromAttribute(
				selected!.instruction.attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE],
			)?.candidates,
		).toHaveLength(1);
	});
});
