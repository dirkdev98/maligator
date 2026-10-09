import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import {
	selectNativeRootStorage,
	validateNativeRootStorage,
} from "../src/compiler/target/lower-native-roots.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { NativeFunctionPlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeExceptionHandler,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";

function compile() {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel = function kernel(first, second, consume) {
				const left = first();
				consume(left);
				const right = second();
				return consume(right);
			};`,
			"/root-storage.js",
		),
	);
}

function contract(rootedOutput = false) {
	const template = compile().native.functions[1]!.body;
	const call = (dst: number, arguments_: Array<number> = []): BytecodeInstruction => ({
		opcode: "CALL",
		dst,
		callee: 0,
		thisValue: -1,
		argumentCount: arguments_.length,
		arguments: arguments_,
	});
	const instructions: Array<BytecodeInstruction> = [
		rootedOutput
			? {
					opcode: "CALL_KNOWN",
					dst: 2,
					operation: "Array.from",
					thisValue: -1,
					argumentCount: 1,
					arguments: [1],
				}
			: call(2),
		call(3, [2]),
		call(4),
		call(5, [4]),
		{ opcode: "RETURN", value: 5 },
	];
	const body = {
		...template,
		parameterCount: 2,
		registerCount: 6,
		instructions,
		positions: instructions.map(() => -1),
	};
	const native = createConservativeNativePlan([body]).functions[0]!;
	const live = [
		[
			[0, 1],
			[0, 1, 2],
		],
		[
			[0, 1, 2],
			[0, 1, 3],
		],
		[
			[0, 1],
			[0, 1, 4],
		],
		[
			[0, 1, 4],
			[0, 1, 5],
		],
	];
	return lowerNativeFunctionStorage({
		...native,
		storageValues: Array.from({ length: 6 }, (_, index) => index),
		gc: {
			safepoints: live.map(([incoming, outgoing], instructionIp) => ({
				kind: "operation",
				instructionIp,
				rootRegisters: [...new Set([...incoming!, ...outgoing!])].sort((a, b) => a - b),
				incomingRootRegisters: incoming!,
				outgoingRootRegisters: outgoing!,
			})),
		},
	});
}

describe("native physical root storage", () => {
	it.each([31, 32, 127, 128, 129, 255, 256, 2048])(
		"retains overlap and disjoint sharing at safepoint ordinal %i",
		(ordinal) => {
			const original = contract();
			const native = {
				...original,
				gc: {
					safepoints: Array.from({ length: ordinal + 2 }, (_, instructionIp) => {
						const roots =
							instructionIp < ordinal
								? [0, 1]
								: instructionIp === ordinal
									? [0, 1, 2, 3]
									: [0, 1, 4, 5];
						return {
							kind: "operation" as const,
							instructionIp,
							rootRegisters: roots,
							incomingRootRegisters: roots,
							outgoingRootRegisters: [],
						};
					}),
				},
			};
			const registers = [0, 1, 2, 3, 4, 5];
			const storage = selectNativeRootStorage(
				native,
				registers,
				new Set([2, 3, 4, 5]),
				new Set(original.storage!.privateCallResultIps),
			);
			expect(storage.rootSlotCount).toBe(4);
			expect(storage.rootSlots[2]).not.toBe(storage.rootSlots[3]);
			expect(storage.rootSlots[2]).toBe(storage.rootSlots[4]);
			expect(storage.rootSlots[3]).toBe(storage.rootSlots[5]);
			expect(() => validateNativeRootStorage(native, registers, storage)).not.toThrow();
		},
	);

	it("checks supplied slot interference without reselecting the allocator", () => {
		const native = contract();
		const storage = native.storage!;
		const slots = [...storage.rootSlots];
		slots[storage.rootRegisters.indexOf(3)] = slots[storage.rootRegisters.indexOf(2)]!;
		expect(() =>
			validateNativeRootStorage(native, storage.rootRegisters, {
				...storage,
				rootSlots: slots,
			}),
		).toThrow(/interfering GC roots at 1/);
	});

	it("delegates root-omission legality to the full storage contract", () => {
		const native = contract();
		const storage = native.storage!;
		const kept = storage.rootRegisters.filter((register) => register !== 2);
		expect(() =>
			validateNativeRootStorage(native, kept, {
				rootSlots: kept.map(
					(register) => storage.rootSlots[storage.rootRegisters.indexOf(register)]!,
				),
				rootSlotCount: storage.rootSlotCount,
			}),
		).not.toThrow();
		expect(() =>
			validateNativeStorage({
				...native,
				storage: {
					...storage,
					rootRegisters: kept,
					rootSlots: kept.map(
						(register) => storage.rootSlots[storage.rootRegisters.indexOf(register)]!,
					),
				},
			}),
		).toThrow(/invalid or stale storage plan/);
	});

	it("shares disjoint SSA roots while preserving helper input/output interference", () => {
		const fn = contract();
		const storage = fn.storage!;
		const slots = new Map(
			storage.rootRegisters.map((register, index) => [
				register,
				storage.rootSlots[index],
			]),
		);
		expect(storage.rootSlotCount).toBeLessThan(storage.rootRegisters.length);
		expect(slots.get(2)).toBe(slots.get(4));
		expect(slots.get(3)).toBe(slots.get(5));
		for (const point of fn.gc.safepoints)
			expect(
				new Set(point.rootRegisters.map((register) => slots.get(register))).size,
			).toBe(point.rootRegisters.length);
		for (const parameter of [0, 1])
			expect(
				storage.rootSlots.filter((slot) => slot === slots.get(parameter)),
			).toHaveLength(1);
	});

	it("shares a private helper output's slot only with roots disjoint from its own safepoint", () => {
		const storage = contract(true).storage!;
		const slotOf = (register: number) =>
			storage.rootSlots[storage.rootRegisters.indexOf(register)];
		expect(storage.privateRegisters).toContain(2);
		expect(slotOf(2)).toBe(slotOf(4));
		expect(slotOf(2)).not.toBe(slotOf(3));
	});

	it("renders a shared slot's live occupant without clearing it for its dead aliases", () => {
		const fn = contract();
		const source = emitCompiledFunction(fn, 0, "", false)!.source;
		const slot = fn.storage!.rootSlots[fn.storage!.rootRegisters.indexOf(2)];
		const call = source.indexOf("MalCompletion call_result_1 =");
		const precedingCall = source.indexOf("r2 = call_result_0.value;");
		const publication = source.slice(precedingCall, call);
		expect(publication).toContain(`__gc_slots[${slot}] = r2;`);
		expect(publication).not.toContain(`__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`);
		expect(source).toContain(`MalValue __gc_slots[${fn.storage!.rootSlotCount}];`);
	});

	it("zeroes only entry storage that a fresh frame can observe before definition", () => {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(
				`globalThis.kernel = function kernel(first, second, consume) {
					let held = first();
					consume(held);
					if (consume()) held = second();
					consume(held);
					return consume(held);
				};`,
				"/definition-roots.js",
			),
		);
		for (const fn of [image.native.functions[1]!, contract(true)]) {
			const storage = fn.storage!;
			const source = emitCompiledFunction(fn, fn.functionIndex, "", false)!.source;
			const prologue = source.slice(
				0,
				source.indexOf("vm->root_frame_head = &__gc_frame;"),
			);
			const defined = new Set(storage.definitionInitializedRegisters);
			const privateRegisters = new Set(storage.privateRegisters);
			const privateDefined = storage.privateRegisters.filter((r) => defined.has(r));
			expect(privateDefined.length).toBeGreaterThan(0);
			for (const register of privateDefined) {
				expect(prologue).not.toContain(`    r${register} = `);
				expect(prologue).not.toMatch(new RegExp(`__gc_slots\\[\\d+\\] = r${register};`));
			}
			for (const register of storage.rootRegisters)
				if (!privateRegisters.has(register) && register >= fn.body.parameterCount)
					expect(prologue).toContain(`    r${register} = MAL_VALUE_UNDEFINED;`);
		}
		const rootedOutput = contract(true);
		const slot =
			rootedOutput.storage!.rootSlots[rootedOutput.storage!.rootRegisters.indexOf(2)]!;
		expect(rootedOutput.storage!.definitionInitializedRegisters).toContain(2);
		expect(emitCompiledFunction(rootedOutput, 0, "", false)!.source).toContain(
			`    __gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`,
		);
	});

	it("refuses to render a stale GC map that makes shared private occupants interfere", () => {
		const fn = contract();
		const [first, ...rest] = fn.gc.safepoints;
		const roots = [0, 1, 2, 4];
		const stale = {
			...fn,
			gc: {
				safepoints: [
					{
						...first!,
						rootRegisters: roots,
						incomingRootRegisters: roots,
						outgoingRootRegisters: roots,
					},
					...rest,
				],
			},
		};
		expect(() => emitCompiledFunction(stale, 0, "", false)).toThrow(
			/private roots interfere at 0/,
		);
	});

	it("trusts only the exact lowered native program at emission and serialization", () => {
		const image = compile();
		expect(Object.isFrozen(image.native)).toBe(true);
		expect(() => {
			(image.native.functions as Array<NativeFunctionPlan>)[1] =
				image.native.functions[0]!;
		}).toThrow(TypeError);
		expect(() => serializeCompilerArtifact(image)).not.toThrow();
		const forged = {
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((plan, index) =>
					index === 1
						? {
								...plan,
								storage: {
									...plan.storage!,
									rootSlots: plan.storage!.rootSlots.map(() => 0),
								},
							}
						: plan,
				),
			},
		};
		expect(() => emitProgramImage(forged)).toThrow(/invalid or stale storage plan/);
		expect(() => serializeCompilerArtifact(forged)).toThrow(
			/invalid or stale storage plan/,
		);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(Object.isFrozen(restored.native)).toBe(true);
	});

	it("round-trips the selected layout and rejects forged slot aliases and frame sizes", () => {
		const image = compile();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(
			image.native.functions[1]!.storage,
		);
		const actual = restored.native.functions[1]!;
		expect(actual.storage!.rootSlotCount).toBeLessThan(
			actual.storage!.rootRegisters.length,
		);
		expect(emitCompiledFunction(actual, actual.functionIndex, "", false)).not.toBeNull();
		const fn = contract();
		for (const storage of [
			{ ...fn.storage!, rootSlots: fn.storage!.rootSlots.map(() => 0) },
			{ ...fn.storage!, rootSlotCount: fn.storage!.rootSlotCount - 1 },
		])
			expect(() => validateNativeStorage({ ...fn, storage })).toThrow(
				/invalid or stale storage plan/,
			);
	});
});

function continuousRootSlots(
	instructions: Array<BytecodeInstruction>,
	registers: Array<number>,
	liveRoots: ReadonlyArray<readonly [ip: number, roots: Array<number>]>,
	handlers: Array<BytecodeExceptionHandler> = [],
): ReadonlyMap<number, number> {
	const template = compile().native.functions[1]!.body;
	const body = {
		...template,
		parameterCount: 0,
		argumentSnapshotCount: 0,
		registerCount: 8,
		instructions,
		handlers,
		positions: instructions.map(() => -1),
	};
	const native = {
		...createConservativeNativePlan([body]).functions[0]!,
		storageValues: Array.from({ length: 8 }, (_, index) => index),
		gc: {
			safepoints: liveRoots.map(([instructionIp, roots]) => ({
				kind: "operation" as const,
				instructionIp,
				rootRegisters: roots,
				incomingRootRegisters: roots,
				outgoingRootRegisters: roots,
			})),
		},
	};
	const storage = selectNativeRootStorage(native, registers, new Set(), new Set(), {
		registers: new Set(registers),
		facts: analyzeNativeBodyFacts(body),
	});
	return new Map(
		registers.map((register, index) => [register, storage.rootSlots[index]!]),
	);
}

describe("continuously rooted storage sharing", () => {
	it("reuses a slot after its occupant's last read but not across an overlap between safepoints", () => {
		const slots = continuousRootSlots(
			[
				{ opcode: "CREATE_OBJECT", dst: 2 },
				{ opcode: "MOVE", dst: 6, src: 2 },
				{ opcode: "CREATE_OBJECT", dst: 3 },
				{ opcode: "MOVE", dst: 4, src: 0 },
				{ opcode: "MOVE", dst: 6, src: 3 },
				{ opcode: "CREATE_OBJECT", dst: 5 },
				{ opcode: "MOVE", dst: 6, src: 4 },
				{ opcode: "RETURN", value: 5 },
			],
			[2, 3, 4],
			[
				[0, [2]],
				[2, [3]],
				[5, [4, 5]],
			],
		);
		expect(slots.get(2)).toBe(slots.get(3));
		expect(slots.get(4)).not.toBe(slots.get(3));
	});

	it("keeps a value read on the next loop iteration live past its last read in program order", () => {
		const slots = continuousRootSlots(
			[
				{ opcode: "CREATE_OBJECT", dst: 2 },
				{ opcode: "MOVE", dst: 6, src: 2 },
				{ opcode: "MOVE", dst: 4, src: 6 },
				{ opcode: "JUMP_IF", cond: 7, targetIp: 1 },
				{ opcode: "CREATE_OBJECT", dst: 5 },
				{ opcode: "MOVE", dst: 6, src: 4 },
				{ opcode: "RETURN", value: 5 },
			],
			[2, 4],
			[
				[0, [2]],
				[4, [4, 5]],
			],
		);
		expect(slots.get(2)).not.toBe(slots.get(4));
	});

	it("keeps a value its exception handler reads live across the protected range", () => {
		const slots = continuousRootSlots(
			[
				{ opcode: "CREATE_OBJECT", dst: 2 },
				{ opcode: "MOVE", dst: 3, src: 0 },
				{ opcode: "MOVE", dst: 6, src: 0 },
				{ opcode: "CREATE_OBJECT", dst: 4 },
				{ opcode: "MOVE", dst: 6, src: 3 },
				{ opcode: "RETURN", value: 6 },
				{ opcode: "CATCH", dst: 5 },
				{ opcode: "MOVE", dst: 6, src: 2 },
				{ opcode: "RETURN", value: 6 },
			],
			[2, 3],
			[
				[0, [2]],
				[3, [3, 4]],
			],
			[{ startIp: 0, endIp: 3, handlerIp: 6 }],
		);
		expect(slots.get(2)).not.toBe(slots.get(3));
	});
});
