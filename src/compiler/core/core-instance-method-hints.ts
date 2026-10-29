import { coreDirectCreatedFunction } from "./core-ir-call-targets.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
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
	// A derived class creates its prototype object and installs it on the constructor.
	if (opcode === "createObject") return installedPrototypeOwner(program, fn, value);
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

function installedPrototypeOwner(
	program: CoreProgram,
	fn: CoreFunctionStore,
	prototype: CoreValueId,
): CoreFunctionId | undefined {
	for (
		let use = fn.kernel.valueFirstUse(prototype);
		use >= 0;
		use = fn.kernel.useNext(use)
	) {
		if (fn.kernel.useOperand(use) !== 2) continue;
		const instruction = fn.kernel.useInstruction(use);
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "defineProperty"
		) {
			continue;
		}
		const [owner, key] = materializeInstructionOperands(fn, instruction);
		const stringIndex = key === undefined ? undefined : directStringIndex(fn, key);
		if (
			owner === undefined ||
			stringIndex === undefined ||
			!stringConstantEquals(program, stringIndex, "prototype")
		) {
			continue;
		}
		return coreDirectCreatedFunction(fn, owner);
	}
	return undefined;
}

/**
 * Class methods by name, which guess the callee of a method call. The toolchain's own
 * classes guess only for toolchain code: their names say nothing about application calls.
 */
export interface CoreInstanceMethodHints {
	readonly toolchain: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>;
	readonly application: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>;
}

export function coreInstanceMethodHints(program: CoreProgram): CoreInstanceMethodHints {
	const hints = new Map<number, Array<CoreFunctionId>>();
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
			if (stringIndex === undefined || target === undefined) continue;
			const targets = hints.get(stringIndex) ?? [];
			if (!targets.includes(target)) targets.push(target);
			hints.set(stringIndex, targets);
		}
	}
	const application = new Map<number, ReadonlyArray<CoreFunctionId>>();
	for (const [stringIndex, targets] of hints) {
		const owned = targets.filter(
			(target) => program.function(target).metadata.toolchain !== true,
		);
		if (owned.length > 0) application.set(stringIndex, owned);
	}
	return { toolchain: hints, application };
}

export interface CoreAccessorHints {
	readonly getters: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>;
	readonly setters: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>;
	/** Names some object literal, store, or definition also gives an ordinary property. */
	readonly ordinary: ReadonlySet<number>;
}

/** Object keys of a literal template value starting at `position`; returns the next position. */
export function literalTemplateKeys(
	data: ReadonlyArray<number>,
	position: number,
	keys: Set<number>,
	depth = 0,
): number {
	if (depth > 128 || position >= data.length) return data.length;
	const tag = data[position++]!;
	if (tag === 3 || tag === 5 || tag === 6) return position + 1;
	if (tag === 4) return position + 2;
	if (tag !== 8 && tag !== 9) return position;
	const count = data[position++]!;
	for (let index = 0; index < count && position < data.length; index++) {
		if (tag === 9) {
			position++;
			keys.add(data[position++]!);
		}
		position = literalTemplateKeys(data, position, keys, depth + 1);
	}
	return position;
}

/** Class prototype getters and setters by static name. */
export function coreAccessorHints(program: CoreProgram): CoreAccessorHints {
	const getters = new Map<number, Array<CoreFunctionId>>();
	const setters = new Map<number, Array<CoreFunctionId>>();
	const ordinary = new Set<number>();
	// A store of a name with a class setter is usually that setter's call.
	const stored = new Set<number>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			const attributes = fn.kernel.instructionAttributes(instruction);
			if (
				opcode === "storePropertyStatic" &&
				typeof attributes.stringIndex === "number"
			) {
				stored.add(attributes.stringIndex);
				continue;
			}
			if (opcode === "createObjectShaped" && Array.isArray(attributes.keyStringIndices)) {
				for (const key of attributes.keyStringIndices)
					if (typeof key === "number") ordinary.add(key);
				continue;
			}
			if (
				opcode === "instantiateLiteralTemplate" &&
				typeof attributes.templateOffset === "number"
			) {
				literalTemplateKeys(
					program.literalTemplateData,
					attributes.templateOffset,
					ordinary,
				);
				continue;
			}
			if (opcode === "storeProperty" || opcode === "defineProperty") {
				const key = materializeInstructionOperands(fn, instruction)[1];
				const stringIndex = key === undefined ? undefined : directStringIndex(fn, key);
				if (stringIndex !== undefined) ordinary.add(stringIndex);
				continue;
			}
			if (opcode !== "defineAccessor") continue;
			const [receiver, key, value] = materializeInstructionOperands(fn, instruction);
			if (receiver === undefined || key === undefined || value === undefined) continue;
			const stringIndex = directStringIndex(fn, key);
			if (stringIndex === undefined) continue;
			const owner = directFunctionPrototypeOwner(program, fn, receiver);
			const target = coreDirectCreatedFunction(fn, value);
			const hints =
				attributes.kind === "get"
					? getters
					: attributes.kind === "set"
						? setters
						: undefined;
			if (
				owner === undefined ||
				!program.function(owner).metadata.isClassConstructor ||
				target === undefined ||
				hints === undefined
			) {
				ordinary.add(stringIndex);
				continue;
			}
			const targets = hints.get(stringIndex) ?? [];
			if (!targets.includes(target)) targets.push(target);
			hints.set(stringIndex, targets);
		}
	}
	for (const stringIndex of stored)
		if (!setters.has(stringIndex)) ordinary.add(stringIndex);
	return { getters, setters, ordinary };
}

/** The receiver and expected accessor of a getter or setter probe result. */
function accessorProbe(
	fn: CoreFunctionStore,
	value: CoreValueId,
): { readonly receiver: CoreValueId; readonly target: CoreFunctionId } | undefined {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	if (fn.instructionOpcodeName(definition) !== "probeRead") return undefined;
	const { readKind, functionIndex } = fn.instructionAttributes(definition);
	const receiver = materializeInstructionOperands(fn, definition)[0];
	return (readKind === "getter" || readKind === "setter") &&
		typeof functionIndex === "number" &&
		receiver !== undefined &&
		fn.kernel.resultAt(fn.kernel.instructionResultStart(definition)) === value
		? { receiver, target: coreFunctionId(functionIndex) }
		: undefined;
}

export function coreInstanceMethodTargets(
	fn: CoreFunctionStore,
	callee: CoreValueId,
	receiver: CoreValueId | undefined,
	hints: CoreInstanceMethodHints,
): ReadonlyArray<CoreFunctionId> | undefined {
	const accessor = accessorProbe(fn, callee);
	if (accessor !== undefined)
		return receiver !== undefined &&
			canonicalMoveRoot(fn, accessor.receiver) === canonicalMoveRoot(fn, receiver)
			? [accessor.target]
			: undefined;
	const load = staticPropertyLoad(fn, callee);
	if (
		load === undefined ||
		receiver === undefined ||
		canonicalMoveRoot(fn, load.receiver) !== canonicalMoveRoot(fn, receiver)
	) {
		return undefined;
	}
	const targets = (
		fn.metadata.toolchain === true ? hints.toolchain : hints.application
	).get(load.stringIndex);
	return targets !== undefined && targets.length <= 4 ? targets : undefined;
}

export function coreInstanceMethodHint(
	fn: CoreFunctionStore,
	callee: CoreValueId,
	receiver: CoreValueId | undefined,
	hints: CoreInstanceMethodHints,
): CoreFunctionId | undefined {
	const targets = coreInstanceMethodTargets(fn, callee, receiver, hints);
	return targets?.length === 1 ? targets[0] : undefined;
}
