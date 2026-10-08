import { describe, expect, it } from "vitest";
import { lowerNativeSuspension } from "../src/compiler/target/lower-native-suspension.ts";
import type { NativeFunctionPlan } from "../src/compiler/target/program-image.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import {
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "../src/compiler/target/runtime-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";

function fixture(
	instructions: Array<BytecodeInstruction>,
	handlers: BytecodeFunction["handlers"] = [],
) {
	const fn: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: true,
		parameterCount: 0,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 0,
		registerCount: 145,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		constructorSlotReserve: 0,
		hasPrototype: false,
		propertyIcCount: 0,
		literalShapeCount: 0,
		instructions,
		handlers,
		fileIndex: -1,
		positions: [],
	};
	const original = createConservativeNativePlan([fn]).functions[0]!;
	return {
		...original,
		registerRepresentations: Array.from({ length: fn.registerCount }, (_, r) =>
			r === 3 ? "boxed" : r === 4 ? "string" : "number",
		),
		gc: {
			safepoints: instructions.flatMap((op, instructionIp) =>
				["GENERATOR_START", "YIELD", "AWAIT"].includes(op.opcode)
					? [
							{
								kind: "operation",
								instructionIp,
								rootRegisters: [3],
								incomingRootRegisters: [3],
								outgoingRootRegisters: [3],
							},
						]
					: [],
			),
		},
	} satisfies NativeFunctionPlan;
}

function referencePoints(native: NativeFunctionPlan) {
	const fn = native.body;
	const handlers = vmExceptionHandlerTargets(fn.instructions.length, fn.handlers);
	const successors = fn.instructions.map((op, ip) => {
		const result: Array<number> = [];
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") result.push(op.targetIp);
		if (
			!["JUMP", "RETURN", "THROW", "TERMINAL_YIELD"].includes(op.opcode) &&
			ip + 1 < fn.instructions.length
		)
			result.push(ip + 1);
		if (handlers[ip] !== undefined) result.push(handlers[ip]);
		return result;
	});
	const live = fn.instructions.map(() => new Set<number>());
	let changed = true;
	while (changed) {
		changed = false;
		for (let ip = fn.instructions.length - 1; ip >= 0; ip--) {
			const next = new Set(successors[ip]!.flatMap((target) => [...live[target]!]));
			for (const register of vmInstructionWriteRegisters(fn.instructions[ip]!))
				next.delete(register);
			if (handlers[ip] !== undefined)
				for (const register of live[handlers[ip]!]!) next.add(register);
			for (const register of vmInstructionReadRegisters(fn.instructions[ip]!))
				if (register >= 0) next.add(register);
			if (next.size === live[ip]!.size && [...next].every((r) => live[ip]!.has(r)))
				continue;
			live[ip] = next;
			changed = true;
		}
	}
	return fn.instructions.flatMap((op, instructionIp) => {
		if (op.opcode !== "GENERATOR_START" && op.opcode !== "YIELD" && op.opcode !== "AWAIT")
			return [];
		const saved = new Set(
			successors[instructionIp]!.flatMap((target) => [...live[target]!]),
		);
		for (const register of saved)
			if (["boxed", "string"].includes(native.registerRepresentations[register]!))
				saved.delete(register);
		for (const register of native.gc.safepoints.find(
			(point) => point.instructionIp === instructionIp,
		)?.outgoingRootRegisters ?? [])
			saved.add(register);
		if (op.opcode !== "GENERATOR_START") {
			saved.delete(op.valueDst);
			saved.delete(op.modeDst);
		}
		return [{ instructionIp, registers: [...saved].sort((a, b) => a - b) }];
	});
}

const awaitPoint: BytecodeInstruction = {
	opcode: "AWAIT",
	awaitedSrc: 0,
	valueDst: 128,
	modeDst: 129,
};

describe("block suspension liveness", () => {
	it("preserves handler-only old values across definitions and changed nested handlers", () => {
		const native = fixture(
			[
				awaitPoint,
				{ opcode: "CREATE_NUMBER", dst: 127, value: 1 },
				{ opcode: "MOVE", dst: 127, src: 127 },
				{ opcode: "RETURN", value: 128 },
				{ opcode: "RETURN", value: 127 },
				{ opcode: "RETURN", value: 131 },
			],
			[
				{ startIp: 0, endIp: 4, handlerIp: 4 },
				{ startIp: 1, endIp: 3, handlerIp: 5 },
			],
		);
		expect(lowerNativeSuspension(native)!.points).toEqual(referencePoints(native));
		expect(lowerNativeSuspension(native)!.points[0]!.registers).toEqual([3, 127, 131]);
	});

	it("preserves undeclared fallthrough, self-use and unreachable cycles beside terminal yield", () => {
		const native = fixture([
			{ opcode: "GENERATOR_START" },
			{ opcode: "LOAD_UNDECLARED", dst: 1, nameStringIndex: 0 },
			{ opcode: "MOVE", dst: 127, src: 127 },
			{ opcode: "TERMINAL_YIELD", yieldedSrc: 127 },
			awaitPoint,
			{ opcode: "JUMP_IF", cond: 131, targetIp: 4 },
			{ opcode: "RETURN", value: 3 },
		]);
		expect(lowerNativeSuspension(native)!.points).toEqual(referencePoints(native));
		expect(lowerNativeSuspension(native)!.points[0]!.registers).toEqual([3, 127]);
		expect(lowerNativeSuspension(native)!.points[1]!.registers).toEqual([0, 3, 131]);
	});

	it("matches an instruction Set solver across branching and exceptional graphs", () => {
		let state = 0x6e617469;
		const pick = (limit: number) => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state % limit;
		};
		for (let sample = 0; sample < 64; sample++) {
			const length = 5 + pick(26);
			const instructions = Array.from({ length }, (_, ip): BytecodeInstruction => {
				if (ip === 0) return { opcode: "GENERATOR_START" };
				const register = pick(145);
				switch (pick(9)) {
					case 0:
						return awaitPoint;
					case 1:
						return { opcode: "MOVE", dst: register, src: pick(145) };
					case 2:
						return { opcode: "JUMP_IF", cond: register, targetIp: pick(length) };
					case 3:
						return { opcode: "JUMP", targetIp: pick(length) };
					case 4:
						return { opcode: "RETURN", value: register };
					case 5:
						return { opcode: "THROW", value: register };
					case 6:
						return { opcode: "YIELD", yieldedSrc: register, valueDst: 128, modeDst: 129 };
					case 7:
						return { opcode: "TERMINAL_YIELD", yieldedSrc: register };
					default:
						return { opcode: "CREATE_NUMBER", dst: register, value: 1 };
				}
			});
			const native = fixture(instructions, [
				{ startIp: 1, endIp: length - 1, handlerIp: length - 1 },
			]);
			expect(lowerNativeSuspension(native)!.points, `graph ${sample}`).toEqual(
				referencePoints(native),
			);
		}
	});

	it("keeps empty resumables empty", () => {
		expect(lowerNativeSuspension(fixture([]))).toEqual({
			points: [],
			valueSlot: 0,
			modeSlot: 1,
			slotCount: 2,
		});
	});
});
