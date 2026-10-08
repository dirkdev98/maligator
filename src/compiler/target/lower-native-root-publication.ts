import type { NativeCallTransportPlan } from "./lower-native-calls.ts";
import { nativeProfitablePrivateRootRegisters } from "./lower-native-root-profitability.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import {
	vmInstructionReadRegisters,
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

export function nativePrivateCallResultIps(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	callTransports: ReadonlyArray<NativeCallTransportPlan> = [],
): ReadonlySet<number> {
	if (fn.isGenerator || fn.isAsync) return new Set();
	const conflicts = new Set(native.regionActions.map(({ ip }) => ip));
	for (const region of native.specializations)
		for (const ip of region.claimedIps) conflicts.add(ip);
	for (const call of native.fieldCalls ?? [])
		for (let ip = call.allocationIp; ip <= call.callIp; ip++) conflicts.add(ip);
	const transportedCalls = new Set(
		callTransports
			.filter(
				(plan) =>
					plan.targets.length > 0 &&
					plan.targets.every((target) => target.fields.length === 0),
			)
			.map((plan) => plan.instructionIp),
	);
	const privateResults = new Set<number>();
	for (const { instructionIp } of native.gc.safepoints) {
		const op = fn.instructions[instructionIp];
		if (op?.opcode !== "CALL" || conflicts.has(instructionIp)) continue;
		const call = native.instructions[instructionIp];
		// Selected script transports assign only the final value, including guard misses.
		if (
			call === undefined ||
			(call.kind === "call" &&
				native.registerRepresentations[op.dst] === "boxed" &&
				transportedCalls.has(instructionIp) &&
				(call.directFunctionIndex !== undefined ||
					(call.guardedFunctionIndices?.length ?? 0) > 0) &&
				call.directFunctionCall !== true &&
				call.guardedBuiltinCall === undefined &&
				call.numericSortCallback === undefined &&
				call.exactCollectionReceiver === undefined &&
				call.directStringCharCodeAtPosition === undefined &&
				call.directCallTargetFunctionIndex === undefined &&
				call.directCallbackFunctionIndex === undefined)
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
	"CREATE_FUNCTION",
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
 * Traced SSA values become private locals only when every definition
 * either assigns final values or has an explicit continuously rooted output
 * contract. Exact execution maps determine publication at collecting edges.
 * Unmodeled target-region intermediates keep continuously rooted storage.
 */
export function nativePrivateRootRegisters(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	frameRegisters: ReadonlySet<number>,
	privateCallResultIps = nativePrivateCallResultIps(fn, native),
	body?: Pick<NativeBodyFacts, "reads" | "writes" | "rootProfitability">,
): ReadonlySet<number> {
	if (fn.isGenerator || fn.isAsync) return new Set();
	const candidates = new Set<number>(
		native.storageValues === undefined ? [] : frameRegisters,
	);
	for (const [ip, instruction] of fn.instructions.entries()) {
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			native.instructions[ip] === undefined
		) {
			if (frameRegisters.has(instruction.object)) candidates.add(instruction.object);
			if (frameRegisters.has(instruction.dst)) candidates.add(instruction.dst);
		} else if (
			instruction.opcode === "LOAD_PROPERTY" &&
			native.instructions[ip] === undefined &&
			(native.registerRepresentations[instruction.key] === "int32" ||
				native.registerRepresentations[instruction.key] === "number") &&
			frameRegisters.has(instruction.dst)
		) {
			// The ordinary numeric probe writes a final result without collecting.
			candidates.add(instruction.dst);
		}
	}
	// Keep the receiver identity of ordinary numeric indexed reads private too.
	// Append after existing candidates so the bounded selection keeps its order.
	for (const [ip, instruction] of fn.instructions.entries()) {
		if (
			instruction.opcode === "LOAD_PROPERTY" &&
			native.instructions[ip] === undefined &&
			(native.registerRepresentations[instruction.key] === "int32" ||
				native.registerRepresentations[instruction.key] === "number") &&
			frameRegisters.has(instruction.object)
		) {
			candidates.add(instruction.object);
		}
	}
	if (candidates.size === 0) return candidates;
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
		for (const register of body?.writes[call.allocationIp] ??
			vmInstructionWriteRegisters(fn.instructions[call.allocationIp]!))
			candidates.delete(register);
	}
	if (candidates.size === 0) return candidates;
	for (const [ip, instruction] of fn.instructions.entries()) {
		if (candidates.size === 0) break;
		const writes = body?.writes[ip] ?? vmInstructionWriteRegisters(instruction);
		// Exact operator kinds refine ordinary final-value expressions, not storage.
		const hasStorageSpecialization =
			native.instructions[ip] !== undefined &&
			native.instructions[ip]?.kind !== "exact-operator-input-kinds";
		const rootedOutputs =
			nativeRootedOutputRegisters(instruction, ip, privateCallResultIps).length > 0 &&
			safepointIps.has(ip);
		const actions = actionsByIp.get(ip);
		if (
			!hasStorageSpecialization &&
			actions === undefined &&
			instruction.opcode !== "LOAD_ARGUMENT"
		) {
			if (
				!PRIVATE_RESULT_OPCODES.has(instruction.opcode) &&
				!privateCallResultIps.has(ip) &&
				!rootedOutputs
			) {
				for (const register of writes) candidates.delete(register);
			}
			continue;
		}
		const reads = body?.reads[ip] ?? vmInstructionReadRegisters(instruction);
		// Every exclusion below needs this instruction to read or write the register.
		for (const register of [...writes, ...reads]) {
			if (!candidates.has(register)) continue;
			const writesRegister = writes.includes(register);
			// Every iterator-step variant writes its final VM outputs only after
			// internally rooted runtime temporaries have returned successfully.
			const finalIteratorOutput =
				instruction.opcode === "ITERATOR_STEP" && writesRegister;
			const finalCallOutput =
				privateCallResultIps.has(ip) && writesRegister && !reads.includes(register);
			const regionRequiresContinuousRoot = actions?.some((action) => {
				const region = native.specializations[action.regionIndex];
				if (region?.kind === "numeric-fusion") {
					// The start can elide a boxed intermediate; the finish always writes
					// its final value. Merely reading an operand does not expose storage.
					return action.role === "start" && writesRegister;
				}
				return writesRegister || reads.includes(register);
			});
			if (
				(writesRegister &&
					!PRIVATE_RESULT_OPCODES.has(instruction.opcode) &&
					!privateCallResultIps.has(ip) &&
					!rootedOutputs) ||
				(!(rootedOutputs && writesRegister) &&
					!finalIteratorOutput &&
					!finalCallOutput &&
					(regionRequiresContinuousRoot ||
						(hasStorageSpecialization &&
							(writesRegister || reads.includes(register))))) ||
				(instruction.opcode === "LOAD_ARGUMENT" && reads.includes(register))
			) {
				candidates.delete(register);
			}
		}
	}
	return nativeProfitablePrivateRootRegisters(fn, native, candidates, body);
}

/** Entry-published parameters need no recopy while their physical registers are unchanged. */
export function nativeEntryStableRootRegisters(
	fn: BytecodeFunction,
	privateRegisters: ReadonlySet<number>,
	writeCounts?: Readonly<Uint32Array>,
): ReadonlySet<number> {
	const stable = new Set(
		[...privateRegisters].filter(
			(register) =>
				register < fn.parameterCount &&
				(writeCounts === undefined || writeCounts[register] === 0),
		),
	);
	if (writeCounts !== undefined) return stable;
	for (const instruction of fn.instructions) {
		if (stable.size === 0) break;
		for (const register of vmInstructionWriteRegisters(instruction))
			stable.delete(register);
	}
	return stable;
}
