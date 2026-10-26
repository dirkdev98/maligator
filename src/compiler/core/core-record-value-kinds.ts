import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreRecordFieldKind {
	readonly key: number;
	readonly mask: number;
}

// Null is the empty normal-result set; undefined includes non-records and escaped objects.
export type CoreRecordValueKind = ReadonlyArray<CoreRecordFieldKind> | null | undefined;

export function sameCoreRecordValueKind(
	left: CoreRecordValueKind,
	right: CoreRecordValueKind,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			left !== null &&
			right !== undefined &&
			right !== null &&
			left.length === right.length &&
			left.every(
				(field, index) =>
					field.key === right[index]!.key && field.mask === right[index]!.mask,
			))
	);
}

export function joinCoreRecordValueKinds(
	left: CoreRecordValueKind,
	right: CoreRecordValueKind,
): CoreRecordValueKind {
	if (left === undefined || right === undefined) return undefined;
	if (left === null) return right;
	if (right === null) return left;
	const fields: Array<CoreRecordFieldKind> = [];
	for (const field of left) {
		const other = right.find((candidate) => candidate.key === field.key);
		if (other !== undefined)
			fields.push(Object.freeze({ key: field.key, mask: field.mask | other.mask }));
	}
	return Object.freeze(fields);
}

export function coreValueOnlyReturned(
	fn: CoreFunctionStore,
	value: CoreValueId,
): boolean {
	const pending = [value];
	const seen = new Set<CoreValueId>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		if (fn.kernel.valueHandlerUseCount(current) > 0) return false;
		for (
			let use = fn.kernel.valueFirstUse(current);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const instruction = fn.kernel.useInstruction(use);
			const kind = fn.instructionKind(instruction);
			if (kind === "return") continue;
			if (kind !== "operation") return false;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "rootUse") continue;
			if (opcode !== "move") return false;
			pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)));
		}
	}
	return true;
}

export function coreReturnedValueDefinition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

const EMPTY_RECORD_KEYS: ReadonlyArray<number> = Object.freeze([]);

function recordKeys(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): ReadonlyArray<number> | undefined {
	if (fn.instructionKind(instruction) !== "operation") return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "createObject" && fn.kernel.instructionOperandCount(instruction) === 0)
		return coreValueOnlyReturned(
			fn,
			fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
		)
			? EMPTY_RECORD_KEYS
			: undefined;
	if (opcode !== "createObjectShaped") return undefined;
	const keys = fn.instructionAttributes(instruction).keyStringIndices;
	if (
		!Array.isArray(keys) ||
		keys.length > 16 ||
		keys.length !== fn.kernel.instructionOperandCount(instruction) ||
		!keys.every(
			(key) => typeof key === "number" && Number.isSafeInteger(key) && key >= 0,
		) ||
		new Set(keys).size !== keys.length ||
		!coreValueOnlyReturned(
			fn,
			fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
		)
	)
		return undefined;
	return keys as ReadonlyArray<number>;
}

export function coreRecordReturnKindInputs(
	fn: CoreFunctionStore,
): ReadonlyArray<CoreValueId> {
	const inputs: Array<CoreValueId> = [];
	if (fn.isAsync || fn.isGenerator) return inputs;
	for (const instruction of fn.instructionIds()) {
		const keys = recordKeys(fn, instruction);
		if (keys === undefined) continue;
		const start = fn.kernel.instructionOperandStart(instruction);
		for (let index = 0; index < keys.length; index++)
			inputs.push(fn.kernel.operandAt(start + index));
	}
	return inputs;
}

/** These are initial own data fields; reading them after a call needs a separate mutation/escape proof. */
export function coreReturnedRecordKinds(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	mask: (value: CoreValueId) => number,
	call: (instruction: CoreInstructionId) => CoreRecordValueKind,
): CoreRecordValueKind {
	if (fn.isAsync || fn.isGenerator) return undefined;
	let result: CoreRecordValueKind = null;
	for (const block of cfg.reachable) {
		const terminator = fn.blockTerminator(block);
		if (fn.instructionKind(terminator) !== "return") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator));
		if (mask(value) === 0) continue;
		const definition = coreReturnedValueDefinition(fn, value);
		if (definition === undefined) return undefined;
		const keys = recordKeys(fn, definition);
		const completion = fn.registry.byId(fn.instructionOpcode(definition)).callTransfer
			?.result;
		let fields: CoreRecordValueKind;
		if (keys !== undefined) {
			const start = fn.kernel.instructionOperandStart(definition);
			fields = Object.freeze(
				keys
					.map((key, index) =>
						Object.freeze({ key, mask: mask(fn.kernel.operandAt(start + index)) }),
					)
					.sort((left, right) => left.key - right.key),
			);
		} else if (
			(completion === "call-completion" || completion === "construct-completion") &&
			coreValueOnlyReturned(
				fn,
				fn.kernel.resultAt(fn.kernel.instructionResultStart(definition)),
			)
		)
			fields = call(definition);
		else return undefined;
		result = joinCoreRecordValueKinds(result, fields);
		if (result === undefined) return undefined;
	}
	return result;
}
