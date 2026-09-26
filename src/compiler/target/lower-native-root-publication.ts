import type { NativeFunctionPlan } from "./program-image.ts";
import {
	vmInstructionUsesRegister,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

const ROOTED_OUTPUT_OPCODES = new Set([
	"CALL",
	"CALL_KNOWN",
	"GET_ITERATOR",
	"GET_ASYNC_ITERATOR",
	"ITERATOR_NEXT",
]);

/** Ordinary calls publish only their final returned value, after the helper and throw check. */
export function nativePrivateCallResultIps(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
): ReadonlySet<number> {
	if (fn.isGenerator || fn.isAsync) return new Set();
	const conflicts = new Set(native.regionActions.map(({ ip }) => ip));
	for (const call of native.fieldCalls ?? []) conflicts.add(call.callIp);
	const privateResults = new Set<number>();
	for (const { instructionIp } of native.gc.safepoints) {
		if (
			fn.instructions[instructionIp]?.opcode === "CALL" &&
			native.instructions[instructionIp] === undefined &&
			!conflicts.has(instructionIp)
		)
			privateResults.add(instructionIp);
	}
	return privateResults;
}

/** Outputs whose intermediate values stay in shadow storage for the whole op. */
export function nativeRootedOutputRegisters(
	instruction: BytecodeInstruction,
	ip: number,
	privateCallResultIps: ReadonlySet<number>,
): ReadonlyArray<number> {
	return ROOTED_OUTPUT_OPCODES.has(instruction.opcode) && !privateCallResultIps.has(ip)
		? vmInstructionWriteRegisters(instruction)
		: [];
}

// These definitions assign final values after their helpers return. Compound operations and helpers
// which write through an out-parameter must retain continuously rooted storage.
const PRIVATE_RESULT_OPCODES = new Set([
	"MOVE",
	"CREATE_UNDEFINED",
	"CREATE_NULL",
	"CREATE_EMPTY",
	"CREATE_BOOLEAN",
	"CREATE_NUMBER",
	"CREATE_F64",
	"CREATE_STRING",
	"CREATE_BIGINT",
	"CREATE_OBJECT",
	"CREATE_OBJECT_SHAPED",
	"CREATE_ARRAY",
	"LOAD_THIS",
	"LOAD_CAPTURED",
	"LOAD_GLOBAL",
	"LOAD_GLOBAL_INDEX",
	"LOAD_INTRINSIC",
	"LOAD_PROPERTY",
	"LOAD_PROPERTY_STATIC",
	"ITERATOR_STEP",
	"BINARY",
	"UNARY",
	"CATCH",
]);

/**
 * Property receivers/results become private locals only when every definition
 * either assigns final values or has an explicit continuously rooted output
 * contract. Exact execution maps determine publication at collecting edges.
 * Unmodeled target-region intermediates keep continuously rooted storage.
 */
export function nativePrivateRootRegisters(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	frameRegisters: ReadonlySet<number>,
	privateCallResultIps = nativePrivateCallResultIps(fn, native),
): ReadonlySet<number> {
	if (fn.isGenerator || fn.isAsync) return new Set();
	const candidates = new Set<number>();
	for (const [ip, instruction] of fn.instructions.entries()) {
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			native.instructions[ip] === undefined
		) {
			if (frameRegisters.has(instruction.object)) candidates.add(instruction.object);
			if (frameRegisters.has(instruction.dst)) candidates.add(instruction.dst);
		}
	}
	const actionsByIp = new Map<
		number,
		Array<NativeFunctionPlan["regionActions"][number]>
	>();
	for (const action of native.regionActions) {
		const actions = actionsByIp.get(action.ip) ?? [];
		actions.push(action);
		actionsByIp.set(action.ip, actions);
	}
	const safepointIps = new Set(
		native.gc.safepoints.map(({ instructionIp }) => instructionIp),
	);
	for (const call of native.fieldCalls ?? []) {
		// A virtual field argument materializes inside the call fallback, after its
		// incoming publication and before the call can reenter JavaScript.
		for (const register of vmInstructionWriteRegisters(
			fn.instructions[call.allocationIp]!,
		))
			candidates.delete(register);
	}
	for (const [ip, instruction] of fn.instructions.entries()) {
		const writes = vmInstructionWriteRegisters(instruction);
		const rootedOutputs =
			nativeRootedOutputRegisters(instruction, ip, privateCallResultIps).length > 0 &&
			safepointIps.has(ip);
		for (const register of candidates) {
			const writesRegister = writes.includes(register);
			// Every iterator-step variant writes its final VM outputs only after
			// internally rooted runtime temporaries have returned successfully.
			const finalIteratorOutput =
				instruction.opcode === "ITERATOR_STEP" && writesRegister;
			const regionRequiresContinuousRoot = (actionsByIp.get(ip) ?? []).some((action) => {
				const region = native.specializations[action.regionIndex];
				if (region?.kind === "numeric-fusion") {
					// The start can elide a boxed intermediate; the finish always writes
					// its final value. Merely reading an operand does not expose storage.
					return action.role === "start" && writesRegister;
				}
				return writesRegister || vmInstructionUsesRegister(instruction, register);
			});
			if (
				(writesRegister &&
					!PRIVATE_RESULT_OPCODES.has(instruction.opcode) &&
					!privateCallResultIps.has(ip) &&
					!rootedOutputs) ||
				(!(rootedOutputs && writesRegister) &&
					!finalIteratorOutput &&
					(regionRequiresContinuousRoot ||
						(native.instructions[ip] !== undefined &&
							(writesRegister || vmInstructionUsesRegister(instruction, register))))) ||
				(instruction.opcode === "LOAD_ARGUMENT" &&
					vmInstructionUsesRegister(instruction, register))
			) {
				candidates.delete(register);
			}
		}
	}
	// Bound native register pressure and slow-edge code size in large functions.
	return new Set([...candidates].slice(0, 32));
}

/** Entry-published parameters need no recopy while their physical registers are unchanged. */
export function nativeEntryStableRootRegisters(
	fn: BytecodeFunction,
	privateRegisters: ReadonlySet<number>,
): ReadonlySet<number> {
	const stable = new Set(
		[...privateRegisters].filter((register) => register < fn.parameterCount),
	);
	for (const instruction of fn.instructions) {
		if (stable.size === 0) break;
		for (const register of vmInstructionWriteRegisters(instruction))
			stable.delete(register);
	}
	return stable;
}
