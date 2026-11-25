import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
} from "../shared/compiler-value-kinds.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreTerminatorAliasParameter } from "./core-record-value-kinds.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

// The low bits bound the raw payload of a private intrinsic Promise. The high
// bit admits other objects, whose constructor and then behavior is unknown.
const UNPROVEN_PROMISE = 1 << 9;
export const CORE_UNKNOWN_PROMISE = COMPILER_VALUE_KIND_TOP | UNPROVEN_PROMISE;

function primordialName(fn: CoreFunctionStore, value: CoreValueId): unknown {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const attributes = fn.instructionAttributes(instruction);
	switch (fn.instructionOpcodeName(instruction)) {
		case "loadIntrinsic":
			return attributes.intrinsic;
		case "loadPrimordial":
			return getPrimordialCatalog().nodes[attributes.nodeIndex as number]?.[0];
		default:
			return undefined;
	}
}

export function coreIntrinsicPromiseStaticCall(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
):
	| { readonly operation: string; readonly firstArgument: CoreValueId | undefined }
	| undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode !== "callKnown" && opcode !== "call") return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const receiverIndex = opcode === "callKnown" ? 0 : 1;
	const receiver = fn.kernel.operandAt(start + receiverIndex);
	if (primordialName(fn, receiver) !== "Promise") return undefined;
	const operation =
		opcode === "callKnown"
			? attributes.operation
			: primordialName(fn, fn.kernel.operandAt(start));
	if (typeof operation !== "string" || !operation.startsWith("Promise."))
		return undefined;
	const firstArgument =
		receiverIndex + 1 < fn.kernel.instructionOperandCount(instruction)
			? fn.kernel.operandAt(start + receiverIndex + 1)
			: undefined;
	return { operation, firstArgument };
}

type PromiseMethod = "then" | "catch" | "finally";

function promiseMethodName(name: unknown): PromiseMethod | undefined {
	return name === "then" || name === "catch" || name === "finally" ? name : undefined;
}

function promiseMethodLoad(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
) {
	if (fn.instructionOpcodeName(instruction) !== "loadPropertyStatic") return undefined;
	const index = fn.instructionAttributes(instruction).stringIndex;
	return typeof index === "number"
		? promiseMethodName(program.stringConstantText(index))
		: undefined;
}

export function corePromiseContinuation(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
):
	| {
			readonly method: PromiseMethod;
			readonly receiver: CoreValueId;
			readonly first?: CoreValueId;
			readonly second?: CoreValueId;
	  }
	| undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode !== "callKnown" && opcode !== "call") return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	let method: PromiseMethod | undefined;
	const offset = opcode === "callKnown" ? 0 : 1;
	const receiver = fn.kernel.operandAt(start + offset);
	if (opcode === "callKnown") {
		if (
			typeof attributes.operation === "string" &&
			attributes.operation.startsWith("Promise.prototype.")
		)
			method = promiseMethodName(attributes.operation.slice("Promise.prototype.".length));
	} else {
		const callee = fn.kernel.operandAt(start);
		if (fn.kernel.valueDefinitionKind(callee) !== 1) return undefined;
		const load = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
		method = promiseMethodLoad(program, fn, load);
		if (
			method !== undefined &&
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)) !== receiver
		)
			return undefined;
	}
	if (method === undefined) return undefined;
	return {
		method,
		receiver,
		first: count > offset + 1 ? fn.kernel.operandAt(start + offset + 1) : undefined,
		second: count > offset + 2 ? fn.kernel.operandAt(start + offset + 2) : undefined,
	};
}

export function coreSuccessfulAwaitInput(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreValueId | undefined {
	const resumed = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	if (
		fn.kernel.valueDefinitionKind(resumed) !== 1 ||
		fn.kernel.valueDefinitionIndex(resumed) !== 0
	)
		return undefined;
	const producer = coreInstructionId(fn.kernel.valueDefinitionOwner(resumed));
	return fn.instructionOpcodeName(producer) === "await"
		? fn.kernel.operandAt(fn.kernel.instructionOperandStart(producer))
		: undefined;
}

/** The object's constructor and then lookup must stay on the locked intrinsic chain. */
export function corePromiseValueIsPrivate(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	allowArgument?: (instruction: CoreInstructionId, operand: number) => boolean,
	allowReturn = true,
): boolean {
	const pending = [value];
	const seen = new Set<CoreValueId>();
	let budget = 128;
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		if (fn.kernel.valueHandlerUseCount(current) !== 0) return false;
		for (
			let use = fn.kernel.valueFirstUse(current);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			if (--budget < 0) return false;
			const instruction = fn.kernel.useInstruction(use);
			const operand = fn.kernel.useOperand(use);
			const kind = fn.instructionKind(instruction);
			if (kind === "return" && allowReturn) continue;
			if (kind !== "operation") {
				const parameter = coreTerminatorAliasParameter(fn, instruction, operand);
				if (parameter === null || parameter === undefined) return false;
				pending.push(parameter);
				continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "await" || opcode === "rootUse" || opcode === "throwIfTdz") continue;
			if (
				opcode === "loadPropertyStatic" &&
				promiseMethodLoad(program, fn, instruction) !== undefined
			)
				continue;
			if (opcode === "move") {
				pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
				continue;
			}
			if (opcode === "call" || opcode === "callKnown") {
				const receiverOffset = opcode === "call" ? 1 : 0;
				if (
					operand === receiverOffset &&
					corePromiseContinuation(program, fn, instruction) !== undefined
				)
					continue;
				const staticCall = coreIntrinsicPromiseStaticCall(fn, instruction);
				if (
					operand === receiverOffset + 1 &&
					staticCall?.operation === "Promise.resolve"
				) {
					pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
					continue;
				}
			}
			if (!allowArgument?.(instruction, operand)) return false;
		}
	}
	return true;
}

/** Resolving a Promise's object payload can observe a second, mutable then lookup. */
export function corePromiseAdoptedKinds(kind: number, fulfillment: number): number {
	const primitive = kind & ~COMPILER_VALUE_KIND_OBJECT;
	if ((kind & COMPILER_VALUE_KIND_OBJECT) === 0) return primitive;
	return (fulfillment & COMPILER_VALUE_KIND_OBJECT) === 0
		? primitive | fulfillment
		: COMPILER_VALUE_KIND_TOP;
}

export function corePromiseIsProven(mask: number): boolean {
	return (mask & UNPROVEN_PROMISE) === 0;
}
