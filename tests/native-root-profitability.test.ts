import { describe, expect, it } from "vitest";
import { nativePrivateRootRegisters } from "../src/compiler/target/lower-native-root-publication.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";

const retained = 2;
const result = 3;
const call: BytecodeInstruction = {
	opcode: "CALL",
	dst: result,
	callee: 0,
	thisValue: 1,
	argumentCount: 1,
	arguments: [retained],
};
const load: BytecodeInstruction = {
	opcode: "LOAD_PROPERTY_STATIC",
	object: retained,
	dst: result,
	stringIndex: 0,
	icIndex: 0,
};
const initialize: BytecodeInstruction = { opcode: "MOVE", dst: retained, src: 1 };
const backedge: BytecodeInstruction = { opcode: "JUMP_IF", cond: 1, targetIp: 1 };

function select(
	instructions: Array<BytecodeInstruction>,
	options: {
		liveAtCalls?: boolean;
		candidates?: Array<number>;
		parameterCount?: number;
		guardedCalls?: boolean;
	} = {},
) {
	const fn: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: options.parameterCount ?? 2,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 2,
		registerCount: 5,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		constructorSlotReserve: 0,
		hasPrototype: false,
		literalShapeCount: 0,
		instructions,
		handlers: [],
		fileIndex: -1,
		positions: [],
	};
	const native = createConservativeNativePlan([fn]).functions[0]!;
	return nativePrivateRootRegisters(
		fn,
		{
			...native,
			instructions: instructions.map((instruction) =>
				options.guardedCalls && instruction.opcode === "CALL"
					? { kind: "call", guardedFunctionIndices: [1] }
					: undefined,
			),
			gc: {
				safepoints: instructions.flatMap((instruction, instructionIp) =>
					instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN"
						? [
								{
									kind: "operation" as const,
									instructionIp,
									rootRegisters: [0, 1, retained, result],
									incomingRootRegisters:
										options.liveAtCalls === false ? [0, 1] : [0, 1, retained],
									outgoingRootRegisters: [0, 1, retained, result],
								},
							]
						: [],
				),
			},
		},
		new Set(options.candidates ?? [retained]),
	);
}

describe("private-root profitability across collecting loops", () => {
	it("keeps an unrelated loop invariant rooted despite a later property lifetime", () => {
		expect(select([initialize, call, backedge, load])).not.toContain(retained);
	});

	it("retains private storage for a receiver used by property reads inside the loop", () => {
		expect(select([initialize, load, call, backedge])).toContain(retained);
	});

	it("charges guarded direct calls that publish an unrelated invariant", () => {
		expect(
			select([initialize, { ...call, arguments: [], argumentCount: 0 }, backedge, load], {
				guardedCalls: true,
			}),
		).not.toContain(retained);
	});

	it("charges collecting known calls on an ordinary loop cycle", () => {
		const knownCall: BytecodeInstruction = {
			opcode: "CALL_KNOWN",
			dst: result,
			thisValue: 1,
			argumentCount: 1,
			arguments: [retained],
			operation: "Array.from",
		};
		expect(select([initialize, knownCall, backedge, load])).not.toContain(retained);
	});

	it("retains short-lived results that are defined in the loop", () => {
		expect(select([initialize, call, initialize, backedge, load])).toContain(retained);
	});

	it("does not charge a call that does not need the invariant as an incoming root", () => {
		expect(select([initialize, call, backedge, load], { liveAtCalls: false })).toContain(
			retained,
		);
	});

	it("keeps entry-published parameters private without repeated copies", () => {
		expect(select([call, call, backedge, load], { parameterCount: 3 })).toContain(
			retained,
		);
	});

	it("does not turn poll-only loops into continuously rooted storage", () => {
		expect(
			select([
				initialize,
				{ opcode: "MOVE", dst: result, src: retained },
				backedge,
				load,
			]),
		).toContain(retained);
	});

	it("does not treat forward branches as repeated publication", () => {
		expect(
			select([initialize, call, { opcode: "JUMP_IF", cond: 1, targetIp: 3 }, load]),
		).toContain(retained);
	});

	it("does not treat a backward jump into a returning continuation as a loop", () => {
		expect(
			select([
				initialize,
				{ opcode: "JUMP", targetIp: 4 },
				call,
				{ opcode: "RETURN", value: retained },
				load,
				{ opcode: "JUMP", targetIp: 2 },
			]),
		).toContain(retained);
	});

	it("does not charge a one-way exit call that lies textually inside a loop", () => {
		expect(
			select([
				initialize,
				{ opcode: "JUMP_IF", cond: 1, targetIp: 4 },
				call,
				{ opcode: "RETURN", value: retained },
				{ opcode: "JUMP", targetIp: 1 },
				load,
			]),
		).toContain(retained);
	});

	it("keeps a definition on a conditional arm that rejoins the cycle eligible", () => {
		expect(
			select([
				initialize,
				{ opcode: "JUMP_IF", cond: 1, targetIp: 3 },
				initialize,
				call,
				{ opcode: "JUMP", targetIp: 1 },
				load,
			]),
		).toContain(retained);
	});

	it.each([
		["definition", initialize],
		["property benefit", load],
	] as const)("does not credit a %s on a one-way loop exit", (_name, operation) => {
		expect(
			select([
				initialize,
				{ opcode: "JUMP_IF", cond: 1, targetIp: 4 },
				operation,
				{ opcode: "RETURN", value: retained },
				call,
				{ opcode: "JUMP", targetIp: 1 },
				load,
			]),
		).not.toContain(retained);
	});

	it("credits a property benefit on an arm that rejoins before the backedge", () => {
		expect(
			select([
				initialize,
				{ opcode: "JUMP_IF", cond: 1, targetIp: 3 },
				load,
				call,
				{ opcode: "JUMP", targetIp: 1 },
			]),
		).toContain(retained);
	});

	it("keeps an invariant rooted across an inner collecting loop", () => {
		expect(
			select([
				initialize,
				load,
				call,
				{ opcode: "JUMP_IF", cond: 1, targetIp: 2 },
				{ opcode: "JUMP_IF", cond: 1, targetIp: 1 },
			]),
		).not.toContain(retained);
	});

	it("preserves the empty candidate set", () => {
		expect(select([initialize, call, backedge, load], { candidates: [] }).size).toBe(0);
	});
});
