import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreExactHeapBrand } from "./core-heap-brands.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreModulePrivateNames } from "./core-private-names.ts";
import type { CoreModulePrivateNameIndex } from "./core-private-names.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/** What every write of one class-private field can store, and where those writes run. */
export interface CorePrivateFieldFact {
	readonly kinds: CompilerValueKindMask;
	/** The class every value a read can return belongs to, when there is one. */
	readonly brand: CoreExactHeapBrand | undefined;
	/**
	 * Only the activation that added the field to an object stores into it, so the
	 * field keeps one value while any other non-suspending activation runs.
	 */
	readonly constructionOnly: boolean;
	/**
	 * What an element read through an Array-branded field can return when its key
	 * is a number, holes and out-of-range reads included. Undefined when some holder
	 * of those arrays is not visible to the analysis.
	 */
	readonly elements: CompilerValueKindMask | undefined;
}

export interface CorePrivateFieldWrite {
	readonly instruction: CoreInstructionId;
	readonly key: string;
	readonly receiver: CoreValueId;
	/** Undefined for the `undefined` an initializer-less field starts with. */
	readonly value: CoreValueId | undefined;
	/** Defining writes throw rather than replace a field the object already has. */
	readonly defines: boolean;
}

function definition(
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

function capturedSlotKey(owner: unknown, index: unknown): string | undefined {
	return typeof owner === "number" && typeof index === "number"
		? `c:${owner}:${index}`
		: undefined;
}

function operand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

/**
 * Names the private fields a program accesses by the slot its key is loaded from.
 * Only `createPrivateNames` or a validated module-private initializer writes such
 * a slot, so every evaluation of a class reaches the same syntactic field.
 */
export class CorePrivateFieldKeys {
	readonly #names: CoreModulePrivateNameIndex;
	readonly #captured: ReadonlySet<string>;

	constructor(names: CoreModulePrivateNameIndex, captured: ReadonlySet<string>) {
		this.#names = names;
		this.#captured = captured;
	}

	key(fn: CoreFunctionStore, value: CoreValueId): string | undefined {
		const load = definition(fn, value);
		if (load === undefined) return undefined;
		const opcode = fn.instructionOpcodeName(load);
		const attributes = fn.instructionAttributes(load);
		if (opcode === "loadCaptured") {
			const key = capturedSlotKey(attributes.functionIndex, attributes.index);
			return key !== undefined && this.#captured.has(key) ? key : undefined;
		}
		if (opcode !== "loadGlobal") return undefined;
		const slot = this.#names.keySlot(fn, value);
		return slot === undefined ? undefined : `g:${slot}`;
	}

	/** Every private field write in `fn`, or undefined when one names an unknown field. */
	writes(fn: CoreFunctionStore): ReadonlyArray<CorePrivateFieldWrite> | undefined {
		const writes: Array<CorePrivateFieldWrite> = [];
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			if (opcode === "definePrivate" || opcode === "storePrivate") {
				const key = this.key(fn, operand(fn, instruction, 1));
				if (key === undefined) return undefined;
				writes.push({
					instruction,
					key,
					receiver: operand(fn, instruction, 0),
					value: operand(fn, instruction, 2),
					defines: opcode === "definePrivate",
				});
			} else if (opcode === "initPrivateFields") {
				const count = fn.kernel.instructionOperandCount(instruction);
				for (let index = 1; index < count; index++) {
					const key = this.key(fn, operand(fn, instruction, index));
					if (key === undefined) return undefined;
					writes.push({
						instruction,
						key,
						receiver: operand(fn, instruction, 0),
						value: undefined,
						defines: true,
					});
				}
			}
		}
		return writes;
	}
}

/** Private-name slots that nothing but their `createPrivateNames` writes. */
export function corePrivateFieldKeys(
	program: CoreProgram,
	context: CoreCompilationContext,
): CorePrivateFieldKeys {
	const captured = new Set<string>();
	const stored = new Set<string>();
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			const attributes = fn.kernel.instructionAttributes(instruction);
			if (opcode === "createPrivateNames" && Array.isArray(attributes.capturedIndices)) {
				for (const index of attributes.capturedIndices) {
					const key = capturedSlotKey(attributes.functionIndex, index);
					if (key !== undefined) captured.add(key);
				}
			} else if (opcode === "storeCaptured") {
				const key = capturedSlotKey(attributes.functionIndex, attributes.index);
				if (key !== undefined) stored.add(key);
			}
		}
	}
	for (const key of stored) captured.delete(key);
	return new CorePrivateFieldKeys(coreModulePrivateNames(program, context), captured);
}

/** Field facts for a program, keyed by the slot each field's key is loaded from. */
export class CorePrivateFieldFacts {
	readonly keys: CorePrivateFieldKeys;
	readonly #fields: ReadonlyMap<string, CorePrivateFieldFact>;

	constructor(
		keys: CorePrivateFieldKeys,
		fields: ReadonlyMap<string, CorePrivateFieldFact>,
	) {
		this.keys = keys;
		this.#fields = fields;
	}

	/** The fact for the field a private access with key operand `value` reaches. */
	field(fn: CoreFunctionStore, value: CoreValueId): CorePrivateFieldFact | undefined {
		const key = this.keys.key(fn, value);
		return key === undefined ? undefined : this.#fields.get(key);
	}

	/** The kinds a private field read can return. */
	readMask(
		fn: CoreFunctionStore,
		instruction: CoreInstructionId,
	): CompilerValueKindMask | undefined {
		if (fn.instructionOpcodeName(instruction) !== "loadPrivate") return undefined;
		const kinds = this.field(fn, operand(fn, instruction, 1))?.kinds;
		return kinds === 0 ? undefined : kinds;
	}

	/** The element kinds a keyed read from a private field's array can return. */
	elementMask(
		fn: CoreFunctionStore,
		instruction: CoreInstructionId,
	): CompilerValueKindMask | undefined {
		if (
			fn.instructionOpcodeName(instruction) !== "loadProperty" ||
			fn.kernel.instructionOperandCount(instruction) !== 2
		)
			return undefined;
		const source = definition(fn, operand(fn, instruction, 0));
		return source === undefined || fn.instructionOpcodeName(source) !== "loadPrivate"
			? undefined
			: this.field(fn, operand(fn, source, 1))?.elements;
	}
}

const installed = new WeakMap<CoreProgram, CorePrivateFieldFacts>();

// Analyses read these facts but do not depend on a version of them, so they are
// installed once, before any analysis that consumes them is cached.
export function installCorePrivateFieldFacts(
	program: CoreProgram,
	facts: CorePrivateFieldFacts,
): void {
	installed.set(program, facts);
}

export function corePrivateFieldFacts(
	program: CoreProgram,
): CorePrivateFieldFacts | undefined {
	return installed.get(program);
}
