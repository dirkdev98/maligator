import { describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_SHAPE_ORIGIN_CAP,
	analyzeCoreShapeProvenance,
} from "../src/compiler/core/core-ir-shape-provenance.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";

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
		identity.setTerminator(identityEntry, { kind: "return", value: identityMove! });

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
		consumer.setTerminator(consumerEntry, { kind: "return", value: parameterValue! });

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

	it("does not relay shapes through constructs, spread calls, or coroutine body returns", () => {
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
			[0, "callSpread"],
			[1, "call"],
			[2, "call"],
		] as const) {
			const [callee] = caller.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: target },
			});
			const inputs =
				opcode === "construct"
					? [callee!]
					: opcode === "callSpread"
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
		for (const result of results) {
			expect(analysis.candidates(3, result)).toEqual({ origins: [], opaque: true });
		}
	});

	it("keeps entry, exceptional, memory-cell, and template producers open", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry, { parameterCount: 1 });
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
		for (const value of [parameter, handlerArgument, loaded!, template!]) {
			expect(analysis.candidates(0, value)).toEqual({ origins: [], opaque: true });
		}
		expect(analysis.candidates(0, object!).opaque).toBe(false);
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
