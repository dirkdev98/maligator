import { coreDirectCreatedFunction } from "./core-ir-call-targets.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
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

function collectMethodHints(
	program: CoreProgram,
	callTargets?: CoreCallGraphIndex,
): ReadonlyMap<number, ReadonlyArray<CoreFunctionId>> {
	const hints = new Map<number, Array<CoreFunctionId>>();
	const literalHints =
		callTargets === undefined ? undefined : new Map<number, Array<CoreFunctionId>>();
	const add = (key: number, target: CoreFunctionId, literal = false): void => {
		const destination = literal ? literalHints! : hints;
		const targets = destination.get(key) ?? [];
		if (targets.includes(target) || (literal && targets.length === 4)) return;
		targets.push(target);
		destination.set(key, targets);
	};
	const addValue = (fn: CoreFunctionStore, key: number, value: CoreValueId): void => {
		for (const target of callTargets!.targets(fn.id, value).functions) {
			if (!program.function(target).metadata.isClassConstructor) add(key, target, true);
		}
	};
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "createObjectShaped" && callTargets !== undefined) {
				const keys = fn.instructionAttributes(instruction).keyStringIndices;
				if (!Array.isArray(keys)) continue;
				const values = materializeInstructionOperands(fn, instruction);
				for (const [index, key] of keys.entries()) {
					const value = values[index];
					if (typeof key === "number" && value !== undefined) addValue(fn, key, value);
				}
				continue;
			}
			if (opcode !== "defineProperty") continue;
			if (
				callTargets === undefined &&
				fn.instructionAttributes(instruction).enumerable !== false
			)
				continue;
			const [receiver, key, value] = materializeInstructionOperands(fn, instruction);
			if (receiver === undefined || key === undefined || value === undefined) continue;
			const stringIndex = directStringIndex(fn, key);
			if (stringIndex === undefined) continue;
			if (fn.instructionAttributes(instruction).enumerable === false) {
				const owner = directFunctionPrototypeOwner(program, fn, receiver);
				if (owner !== undefined && program.function(owner).metadata.isClassConstructor) {
					const target = coreDirectCreatedFunction(fn, value);
					if (target !== undefined) add(stringIndex, target);
					continue;
				}
			}
			if (callTargets === undefined) continue;
			const root = canonicalMoveRoot(fn, receiver);
			if (fn.kernel.valueDefinitionKind(root) !== 1) continue;
			const allocation = coreInstructionId(fn.kernel.valueDefinitionOwner(root));
			if (fn.instructionOpcodeName(allocation) === "createObject")
				addValue(fn, stringIndex, value);
		}
	}
	if (literalHints !== undefined) {
		for (const [key, literals] of literalHints) {
			const prior = hints.get(key);
			const targets = prior === undefined || prior.length > 4 ? [] : prior;
			// Guarded misses remain canonical, so retain existing class nominees before new literals.
			for (const target of literals)
				if (targets.length < 4 && !targets.includes(target)) targets.push(target);
			hints.set(key, targets);
		}
		for (const [key, targets] of hints) {
			if (targets.length > 4) hints.delete(key);
			else targets.sort((left, right) => left - right);
		}
	}
	return hints;
}

export function coreInstanceMethodHints(
	program: CoreProgram,
): ReadonlyMap<number, ReadonlyArray<CoreFunctionId>> {
	return collectMethodHints(program);
}

// Literal members nominate bodies only; each use must guard the actual loaded closure.
export function coreGuardedMethodHints(
	program: CoreProgram,
	callTargets: CoreCallGraphIndex,
): ReadonlyMap<number, ReadonlyArray<CoreFunctionId>> {
	return collectMethodHints(program, callTargets);
}

export function coreInstanceMethodTargets(
	fn: CoreFunctionStore,
	callee: CoreValueId,
	receiver: CoreValueId | undefined,
	hints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
): ReadonlyArray<CoreFunctionId> | undefined {
	const load = staticPropertyLoad(fn, callee);
	if (
		load === undefined ||
		receiver === undefined ||
		canonicalMoveRoot(fn, load.receiver) !== canonicalMoveRoot(fn, receiver)
	) {
		return undefined;
	}
	const targets = hints.get(load.stringIndex);
	return targets !== undefined && targets.length <= 4 ? targets : undefined;
}

export function coreInstanceMethodHint(
	fn: CoreFunctionStore,
	callee: CoreValueId,
	receiver: CoreValueId | undefined,
	hints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
): CoreFunctionId | undefined {
	const targets = coreInstanceMethodTargets(fn, callee, receiver, hints);
	return targets?.length === 1 ? targets[0] : undefined;
}
