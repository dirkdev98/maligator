import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
} from "../shared/compiler-value-kinds.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreTerminatorAliasParameter } from "./core-record-value-kinds.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

// The low bits bound the raw payload of a private intrinsic Promise. The high
// bit admits other objects, whose constructor and then behavior is unknown.
const UNPROVEN_PROMISE = 1 << 9;
export const CORE_UNKNOWN_PROMISE = COMPILER_VALUE_KIND_TOP | UNPROVEN_PROMISE;
export type CorePromiseArgumentUse = "borrowed" | "possibly-returned";

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

const ARRAY_AGGREGATES = new Set([
	"Promise.all",
	"Promise.allSettled",
	"Promise.any",
	"Promise.race",
]);

export function corePromiseArrayInputs(
	fn: CoreFunctionStore,
	array: CoreValueId,
):
	| {
			readonly call: CoreInstructionId;
			readonly elements: ReadonlyArray<CoreValueId>;
			readonly holes: boolean;
	  }
	| undefined {
	if (
		fn.kernel.valueDefinitionKind(array) !== 1 ||
		fn.kernel.valueHandlerUseCount(array) !== 0
	)
		return undefined;
	const allocation = coreInstructionId(fn.kernel.valueDefinitionOwner(array));
	if (fn.instructionOpcodeName(allocation) !== "createArray") return undefined;
	const length = fn.instructionAttributes(allocation).length;
	if (typeof length !== "number" || length < 0 || length > 32) return undefined;
	const block = fn.instructionBlock(allocation);
	const writes = new Map<CoreInstructionId, { key: number; value: CoreValueId }>();
	let call: CoreInstructionId | undefined;
	for (let use = fn.kernel.valueFirstUse(array); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const instruction = fn.kernel.useInstruction(use);
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionBlock(instruction) !== block
		)
			return undefined;
		const aggregate = coreIntrinsicPromiseStaticCall(fn, instruction);
		if (
			aggregate !== undefined &&
			ARRAY_AGGREGATES.has(aggregate.operation) &&
			aggregate.firstArgument === array
		) {
			if (call !== undefined) return undefined;
			call = instruction;
			continue;
		}
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			(opcode !== "defineProperty" && opcode !== "storeProperty") ||
			fn.kernel.useOperand(use) !== 0
		)
			return undefined;
		const start = fn.kernel.instructionOperandStart(instruction);
		const key = fn.kernel.operandAt(start + 1);
		if (fn.kernel.valueDefinitionKind(key) !== 1) return undefined;
		const keyDefinition = coreInstructionId(fn.kernel.valueDefinitionOwner(key));
		const index = fn.instructionAttributes(keyDefinition).value;
		if (
			fn.instructionOpcodeName(keyDefinition) !== "createNumber" ||
			typeof index !== "number" ||
			!Number.isInteger(index) ||
			index < 0 ||
			index >= length
		)
			return undefined;
		writes.set(instruction, { key: index, value: fn.kernel.operandAt(start + 2) });
	}
	if (call === undefined) return undefined;
	const elements = new Map<number, CoreValueId>();
	let budget = 256;
	for (
		let next = fn.instructionNext(allocation);
		next !== undefined;
		next = fn.instructionNext(next)
	) {
		if (--budget < 0) return undefined;
		if (next === call)
			return writes.size === 0
				? { call, elements: [...elements.values()], holes: elements.size < length }
				: undefined;
		const write = writes.get(next);
		if (write === undefined) continue;
		elements.set(write.key, write.value);
		writes.delete(next);
	}
	return undefined;
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

/** A wrapper can rethrow an awaited callback error without merging its
 * successful results with the callbacks passed by other callers. */
export function coreAwaitedCallbackParameter(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
): number | undefined {
	if (
		!fn.isAsync ||
		fn.isGenerator ||
		fn.metadata.mappedArguments ||
		fn.parameterCount === 0
	)
		return undefined;
	let parameter: CoreValueId | undefined;
	for (const block of control.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		const returned = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
		if (fn.kernel.valueDefinitionKind(returned) !== 1) return undefined;
		const projection = coreInstructionId(fn.kernel.valueDefinitionOwner(returned));
		if (fn.instructionOpcodeName(projection) !== "awaitFulfilled") return undefined;
		const awaited = coreSuccessfulAwaitInput(fn, projection);
		if (awaited === undefined || fn.kernel.valueDefinitionKind(awaited) !== 1)
			return undefined;
		const call = coreInstructionId(fn.kernel.valueDefinitionOwner(awaited));
		if (
			fn.instructionOpcodeName(call) !== "call" ||
			fn.kernel.instructionOperandCount(call) !== 2 ||
			fn.instructionAttributes(call).argumentMode !== undefined
		)
			return undefined;
		const callee = fn.kernel.operandAt(fn.kernel.instructionOperandStart(call));
		if (parameter !== undefined && parameter !== callee) return undefined;
		parameter = callee;
	}
	if (parameter === undefined) return undefined;
	for (let index = 0; index < fn.parameterCount; index++)
		if (fn.kernel.functionParameter(index) === parameter) return index;
	return undefined;
}

/** The object's constructor and then lookup must stay on the locked intrinsic chain. */
export function corePromiseValueIsPrivate(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	allowArgument?: (
		instruction: CoreInstructionId,
		operand: number,
	) => CorePromiseArgumentUse | undefined,
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
			if (kind === "return") continue;
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
			if (
				(opcode === "defineProperty" || opcode === "storeProperty") &&
				operand === 2 &&
				corePromiseArrayInputs(
					fn,
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
				) !== undefined
			)
				continue;
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
			const argumentUse = allowArgument?.(instruction, operand);
			if (argumentUse === undefined) return false;
			if (argumentUse === "possibly-returned")
				pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
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
