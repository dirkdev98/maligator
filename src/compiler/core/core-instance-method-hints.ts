import { coreDirectCreatedFunction } from "./core-ir-call-targets.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

function materializeInstructionOperands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	const values: Array<CoreValueId> = [];
	for (let index = 0; index < count; index++) {
		values.push(fn.kernel.operandAt(start + index));
	}
	return values;
}

function directStringIndex(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): number | undefined {
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition);
	if (opcode === "move") {
		const input = materializeInstructionOperands(fn, definition)[0];
		return input === undefined ? undefined : directStringIndex(fn, input, seen);
	}
	if (opcode !== "createString") return undefined;
	const index = fn.instructionAttributes(definition).stringIndex;
	return typeof index === "number" ? index : undefined;
}

interface StaticPropertyLoad {
	readonly receiver: CoreValueId;
	readonly stringIndex: number;
}

function staticPropertyLoad(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): StaticPropertyLoad | undefined {
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition);
	if (opcode === "move") {
		const input = materializeInstructionOperands(fn, definition)[0];
		return input === undefined ? undefined : staticPropertyLoad(fn, input, seen);
	}
	if (opcode !== "loadPropertyStatic") return undefined;
	const index = fn.instructionAttributes(definition).stringIndex;
	const receiver = materializeInstructionOperands(fn, definition)[0];
	return typeof index === "number" && receiver !== undefined
		? { receiver, stringIndex: index }
		: undefined;
}

function canonicalMoveRoot(
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): CoreValueId {
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return value;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (fn.instructionOpcodeName(definition) !== "move") return value;
	const input = materializeInstructionOperands(fn, definition)[0];
	return input === undefined ? value : canonicalMoveRoot(fn, input, seen);
}

function stringConstantEquals(
	program: CoreProgram,
	index: number,
	value: string,
): boolean {
	const units = program.stringConstants[index];
	return (
		units?.length === value.length &&
		units.every((unit, position) => unit === value.charCodeAt(position))
	);
}

function directFunctionPrototypeOwner(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	seen = new Set<CoreValueId>(),
): CoreFunctionId | undefined {
	if (seen.has(value) || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	seen.add(value);
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition);
	if (opcode === "move") {
		const input = materializeInstructionOperands(fn, definition)[0];
		return input === undefined
			? undefined
			: directFunctionPrototypeOwner(program, fn, input, seen);
	}
	if (opcode !== "loadPropertyStatic") return undefined;
	const stringIndex = fn.instructionAttributes(definition).stringIndex;
	if (
		typeof stringIndex !== "number" ||
		!stringConstantEquals(program, stringIndex, "prototype")
	) {
		return undefined;
	}
	const owner = materializeInstructionOperands(fn, definition)[0];
	return owner === undefined ? undefined : coreDirectCreatedFunction(fn, owner);
}

export function coreInstanceMethodHints(
	program: CoreProgram,
): ReadonlyMap<number, CoreFunctionId> {
	const hints = new Map<number, CoreFunctionId>();
	const ambiguous = new Set<number>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "defineProperty" ||
				fn.instructionAttributes(instruction).enumerable !== false
			) {
				continue;
			}
			const [receiver, key, value] = materializeInstructionOperands(fn, instruction);
			if (receiver === undefined || key === undefined || value === undefined) continue;
			const owner = directFunctionPrototypeOwner(program, fn, receiver);
			if (owner === undefined || !program.function(owner).metadata.isClassConstructor) {
				continue;
			}
			const stringIndex = directStringIndex(fn, key);
			const target = coreDirectCreatedFunction(fn, value);
			if (
				stringIndex === undefined ||
				target === undefined ||
				ambiguous.has(stringIndex)
			) {
				continue;
			}
			const existing = hints.get(stringIndex);
			if (existing === undefined || existing === target) {
				hints.set(stringIndex, target);
			} else {
				hints.delete(stringIndex);
				ambiguous.add(stringIndex);
			}
		}
	}
	return hints;
}

export function coreInstanceMethodHint(
	fn: CoreFunctionStore,
	callee: CoreValueId,
	receiver: CoreValueId | undefined,
	hints: ReadonlyMap<number, CoreFunctionId>,
): CoreFunctionId | undefined {
	const load = staticPropertyLoad(fn, callee);
	if (
		load === undefined ||
		receiver === undefined ||
		canonicalMoveRoot(fn, load.receiver) !== canonicalMoveRoot(fn, receiver)
	) {
		return undefined;
	}
	return hints.get(load.stringIndex);
}
