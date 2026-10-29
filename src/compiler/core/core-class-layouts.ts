import { literalTemplateKeys } from "./core-instance-method-hints.ts";
import { coreDirectCreatedFunction } from "./core-ir-call-targets.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/** An own instance key: a string constant, or a module-private name held in a global slot. */
export interface CoreClassLayoutKey {
	readonly private: boolean;
	readonly index: number;
}

export interface CoreClassLayoutMethod {
	readonly stringIndex: number;
	readonly target: CoreFunctionId;
}

/**
 * The instance layout a class constructor is predicted to build, and the data
 * methods its instances inherit. Predictions are only hints: the runtime admits a
 * layout for a receiver after checking every key slot and method against it.
 */
export interface CoreClassLayout {
	readonly constructor: CoreFunctionId;
	readonly parent: CoreFunctionId | undefined;
	/** Keys in slot order: the straight-line prefix every construction installs. */
	readonly keys: ReadonlyArray<CoreClassLayoutKey>;
	/** Whether every construction installs exactly `keys`, so subclasses extend them. */
	readonly complete: boolean;
	readonly methods: ReadonlyArray<CoreClassLayoutMethod>;
	/** Names an instance resolves to an accessor on its prototype chain. */
	readonly accessors: ReadonlySet<number>;
}

export interface CoreClassLayoutIndex {
	readonly layouts: ReadonlyMap<CoreFunctionId, CoreClassLayout>;
	/** Names some object literal or store outside `this` gives an own data property. */
	readonly ordinaryKeys: ReadonlySet<number>;
	/** Instance methods and accessors by the constructor of the class defining them. */
	readonly methodClass: ReadonlyMap<CoreFunctionId, CoreFunctionId>;
	/** Each class followed by its transitive subclasses. */
	readonly family: ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreFunctionId>>;
	readonly byMethodName: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>;
	readonly byKey: ReadonlyMap<string, ReadonlyArray<CoreFunctionId>>;
}

export function coreClassLayoutKeyId(key: CoreClassLayoutKey): string {
	return `${key.private ? "p" : "s"}${key.index}`;
}

function operands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) => fn.kernel.operandAt(start + index),
	);
}

function definitionOf(
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

function stringIndexOf(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
	const definition = definitionOf(fn, value);
	if (definition === undefined || fn.instructionOpcodeName(definition) !== "createString")
		return undefined;
	const index = fn.instructionAttributes(definition).stringIndex;
	return typeof index === "number" ? index : undefined;
}

function globalSlotOf(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
	const definition = definitionOf(fn, value);
	if (definition === undefined || fn.instructionOpcodeName(definition) !== "loadGlobal")
		return undefined;
	const index = fn.instructionAttributes(definition).index;
	return typeof index === "number" ? index : undefined;
}

function isThis(fn: CoreFunctionStore, value: CoreValueId): boolean {
	const definition = definitionOf(fn, value);
	return definition !== undefined && fn.instructionOpcodeName(definition) === "loadThis";
}

function isPrototypeKey(program: CoreProgram, stringIndex: number | undefined): boolean {
	const units =
		stringIndex === undefined ? undefined : program.stringConstants[stringIndex];
	return (
		units !== undefined &&
		units.length === 9 &&
		String.fromCharCode(...units) === "prototype"
	);
}

interface ClassDefinition {
	readonly fn: CoreFunctionStore;
	readonly prototype: CoreValueId;
}

/** Global slots holding exactly one class constructor besides their TDZ marker. */
function classGlobals(program: CoreProgram): Map<number, CoreFunctionId> {
	const stores = new Map<number, Array<CoreFunctionId | undefined>>();
	const aliases = new Map<number, Array<number>>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "storeGlobal"
			)
				continue;
			const slot = fn.instructionAttributes(instruction).index;
			if (typeof slot !== "number") continue;
			const value = operands(fn, instruction)[0]!;
			const definition = definitionOf(fn, value);
			const opcode =
				definition === undefined ? undefined : fn.instructionOpcodeName(definition);
			if (opcode === "createEmpty") continue;
			const writes = stores.get(slot) ?? [];
			const source = globalSlotOf(fn, value);
			if (source !== undefined) {
				const sourced = aliases.get(slot) ?? [];
				sourced.push(source);
				aliases.set(slot, sourced);
				writes.push(undefined);
			} else writes.push(coreDirectCreatedFunction(fn, value));
			stores.set(slot, writes);
		}
	}
	const resolved = new Map<number, CoreFunctionId>();
	for (const [slot, writes] of stores) {
		if (writes.length !== 1 || writes[0] === undefined) continue;
		if (program.function(writes[0]).metadata.isClassConstructor)
			resolved.set(slot, writes[0]);
	}
	// A heritage slot copies a class binding once; follow such copies a few levels.
	for (let round = 0; round < 4; round++)
		for (const [slot, sources] of aliases) {
			if (resolved.has(slot) || sources.length !== 1 || stores.get(slot)?.length !== 1)
				continue;
			const target = resolved.get(sources[0]!);
			if (target !== undefined) resolved.set(slot, target);
		}
	return resolved;
}

function definesMembers(definition: ClassDefinition): boolean {
	const { fn, prototype } = definition;
	for (
		let use = fn.kernel.valueFirstUse(prototype);
		use >= 0;
		use = fn.kernel.useNext(use)
	) {
		if (fn.kernel.useOperand(use) !== 0) continue;
		const instruction = fn.kernel.useInstruction(use);
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		if (opcode === "defineProperty" || opcode === "defineAccessor") return true;
	}
	return false;
}

function findClassDefinitions(
	program: CoreProgram,
): Map<CoreFunctionId, ClassDefinition> {
	const definitions = new Map<CoreFunctionId, ClassDefinition>();
	const ambiguous = new Set<CoreFunctionId>();
	const record = (constructor: CoreFunctionId, definition: ClassDefinition) => {
		if (!program.function(constructor).metadata.isClassConstructor) return;
		const known = definitions.get(constructor);
		// A heritage clause or `C.prototype` read loads the prototype again without defining on it.
		if (known !== undefined) {
			const knownDefines = definesMembers(known);
			if (knownDefines === definesMembers(definition)) {
				if (knownDefines) ambiguous.add(constructor);
				return;
			}
			if (knownDefines) return;
		}
		definitions.set(constructor, definition);
	};
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			if (opcode === "defineProperty") {
				const [owner, key, value] = operands(fn, instruction);
				if (owner === undefined || key === undefined || value === undefined) continue;
				if (!isPrototypeKey(program, stringIndexOf(fn, key))) continue;
				const constructor = coreDirectCreatedFunction(fn, owner);
				if (constructor !== undefined) record(constructor, { fn, prototype: value });
			} else if (opcode === "loadPropertyStatic" || opcode === "loadProperty") {
				const [owner, key] = operands(fn, instruction);
				if (owner === undefined) continue;
				const stringIndex =
					opcode === "loadPropertyStatic"
						? (fn.instructionAttributes(instruction).stringIndex as number | undefined)
						: key === undefined
							? undefined
							: stringIndexOf(fn, key);
				if (!isPrototypeKey(program, stringIndex)) continue;
				const constructor = coreDirectCreatedFunction(fn, owner);
				if (constructor === undefined) continue;
				// A derived class installs its own prototype object; base classes read theirs.
				if (program.function(constructor).metadata.isDerivedConstructor) continue;
				record(constructor, {
					fn,
					prototype: fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				});
			}
		}
	}
	for (const constructor of ambiguous) definitions.delete(constructor);
	return definitions;
}

interface OwnMembers {
	readonly methods: Map<number, CoreFunctionId>;
	readonly accessors: Set<number>;
	readonly methodFunctions: Array<CoreFunctionId>;
}

function prototypeMembers(definition: ClassDefinition): OwnMembers {
	const { fn, prototype } = definition;
	const methods = new Map<number, CoreFunctionId>();
	const accessors = new Set<number>();
	const methodFunctions: Array<CoreFunctionId> = [];
	for (const instruction of fn.instructionIds()) {
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		if (opcode !== "defineProperty" && opcode !== "defineAccessor") continue;
		const [owner, key, value] = operands(fn, instruction);
		if (owner !== prototype || key === undefined || value === undefined) continue;
		const stringIndex = stringIndexOf(fn, key);
		const target = coreDirectCreatedFunction(fn, value);
		if (target !== undefined) methodFunctions.push(target);
		if (stringIndex === undefined) continue;
		if (opcode === "defineAccessor") {
			accessors.add(stringIndex);
			methods.delete(stringIndex);
		} else if (target !== undefined && !accessors.has(stringIndex)) {
			methods.set(stringIndex, target);
		}
	}
	return { methods, accessors, methodFunctions };
}

interface ConstructorWalk {
	readonly parentSlot: number | undefined;
	readonly keys: ReadonlyArray<CoreClassLayoutKey>;
	readonly complete: boolean;
}

/** Keys the constructor adds to `this` along its single-successor entry path. */
function walkConstructor(fn: CoreFunctionStore): ConstructorWalk {
	const keys: Array<CoreClassLayoutKey> = [];
	const seen = new Set<string>();
	const add = (key: CoreClassLayoutKey) => {
		const id = coreClassLayoutKeyId(key);
		if (seen.has(id)) return;
		seen.add(id);
		keys.push(key);
	};
	let parentSlot: number | undefined;
	const visited = new Set<number>();
	let block = fn.entry;
	for (;;) {
		visited.add(block);
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			const args = operands(fn, instruction);
			if (opcode === "constructSuper" || opcode === "constructSuperExplicit") {
				parentSlot = args[0] === undefined ? undefined : globalSlotOf(fn, args[0]);
				continue;
			}
			if (args[0] === undefined || !isThis(fn, args[0])) continue;
			if (opcode === "definePrivate") {
				const slot = args[1] === undefined ? undefined : globalSlotOf(fn, args[1]);
				if (slot === undefined) return { parentSlot, keys, complete: false };
				add({ private: true, index: slot });
			} else if (opcode === "initPrivateFields") {
				for (const name of args.slice(1)) {
					const slot = globalSlotOf(fn, name);
					if (slot === undefined) return { parentSlot, keys, complete: false };
					add({ private: true, index: slot });
				}
			} else if (opcode === "storePropertyStatic") {
				const stringIndex = fn.instructionAttributes(instruction).stringIndex;
				if (typeof stringIndex !== "number") return { parentSlot, keys, complete: false };
				add({ private: false, index: stringIndex });
			} else if (opcode === "defineProperty" || opcode === "storeProperty") {
				const stringIndex =
					args[1] === undefined ? undefined : stringIndexOf(fn, args[1]);
				if (stringIndex === undefined) return { parentSlot, keys, complete: false };
				add({ private: false, index: stringIndex });
			}
		}
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind === "return") return { parentSlot, keys, complete: true };
		if (kind !== "jump") return { parentSlot, keys, complete: false };
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const next = fn.kernel.terminatorEdgeBlock(edgeStart);
		if (visited.has(next)) return { parentSlot, keys, complete: false };
		block = next;
	}
}

function ordinaryDataKeys(program: CoreProgram): Set<number> {
	const keys = new Set<number>();
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			const attributes = fn.kernel.instructionAttributes(instruction);
			if (opcode === "createObjectShaped" && Array.isArray(attributes.keyStringIndices)) {
				for (const key of attributes.keyStringIndices)
					if (typeof key === "number") keys.add(key);
			} else if (
				opcode === "instantiateLiteralTemplate" &&
				typeof attributes.templateOffset === "number"
			) {
				literalTemplateKeys(program.literalTemplateData, attributes.templateOffset, keys);
			} else if (
				opcode === "storePropertyStatic" ||
				opcode === "storeProperty" ||
				// Class members are non-enumerable definitions; literal members are not.
				(opcode === "defineProperty" && attributes.enumerable !== false)
			) {
				const args = operands(fn, instruction);
				if (args[0] === undefined || isThis(fn, args[0])) continue;
				const key =
					opcode === "storePropertyStatic"
						? (attributes.stringIndex as number | undefined)
						: args[1] === undefined
							? undefined
							: stringIndexOf(fn, args[1]);
				if (typeof key === "number") keys.add(key);
			}
		}
	}
	return keys;
}

export function coreClassLayouts(program: CoreProgram): CoreClassLayoutIndex {
	const definitions = findClassDefinitions(program);
	const globals = classGlobals(program);
	const members = new Map<CoreFunctionId, OwnMembers>();
	const walks = new Map<CoreFunctionId, ConstructorWalk>();
	const methodClass = new Map<CoreFunctionId, CoreFunctionId>();
	for (const [constructor, definition] of definitions) {
		const own = prototypeMembers(definition);
		members.set(constructor, own);
		for (const method of own.methodFunctions) methodClass.set(method, constructor);
		walks.set(constructor, walkConstructor(program.function(constructor)));
	}
	const layouts = new Map<CoreFunctionId, CoreClassLayout>();
	const building = new Set<CoreFunctionId>();
	const build = (constructor: CoreFunctionId): CoreClassLayout | undefined => {
		const known = layouts.get(constructor);
		if (known !== undefined || building.has(constructor)) return known;
		const walk = walks.get(constructor);
		const own = members.get(constructor);
		if (walk === undefined || own === undefined) return undefined;
		building.add(constructor);
		const derived = program.function(constructor).metadata.isDerivedConstructor;
		const parentConstructor =
			derived && walk.parentSlot !== undefined ? globals.get(walk.parentSlot) : undefined;
		const parent = parentConstructor === undefined ? undefined : build(parentConstructor);
		building.delete(constructor);
		// An unresolved heritage leaves the inherited slots and methods unknown.
		if (derived && parent === undefined) return undefined;
		const keys = [...(parent?.keys ?? [])];
		const complete = (parent?.complete ?? true) && walk.complete;
		if (parent === undefined || parent.complete) {
			const inherited = new Set(keys.map(coreClassLayoutKeyId));
			for (const key of walk.keys)
				if (!inherited.has(coreClassLayoutKeyId(key))) keys.push(key);
		}
		const accessors = new Set([...(parent?.accessors ?? []), ...own.accessors]);
		const methods = new Map<number, CoreFunctionId>();
		for (const method of parent?.methods ?? [])
			methods.set(method.stringIndex, method.target);
		for (const [stringIndex, target] of own.methods) {
			methods.set(stringIndex, target);
			accessors.delete(stringIndex);
		}
		for (const stringIndex of own.accessors) methods.delete(stringIndex);
		const layout: CoreClassLayout = Object.freeze({
			constructor,
			parent: parentConstructor,
			keys: Object.freeze(keys),
			complete,
			methods: Object.freeze(
				[...methods].map(([stringIndex, target]) =>
					Object.freeze({ stringIndex, target }),
				),
			),
			accessors,
		});
		layouts.set(constructor, layout);
		return layout;
	};
	for (const constructor of definitions.keys()) build(constructor);
	const children = new Map<CoreFunctionId, Array<CoreFunctionId>>();
	for (const layout of layouts.values()) {
		if (layout.parent === undefined) continue;
		const siblings = children.get(layout.parent) ?? [];
		siblings.push(layout.constructor);
		children.set(layout.parent, siblings);
	}
	const family = new Map<CoreFunctionId, ReadonlyArray<CoreFunctionId>>();
	const collect = (constructor: CoreFunctionId, into: Array<CoreFunctionId>) => {
		into.push(constructor);
		for (const child of children.get(constructor) ?? []) collect(child, into);
	};
	for (const constructor of layouts.keys()) {
		const members: Array<CoreFunctionId> = [];
		collect(constructor, members);
		family.set(constructor, Object.freeze(members));
	}
	const byMethodName = new Map<number, Array<CoreFunctionId>>();
	const byKey = new Map<string, Array<CoreFunctionId>>();
	for (const layout of layouts.values()) {
		for (const { stringIndex } of layout.methods) {
			const list = byMethodName.get(stringIndex) ?? [];
			list.push(layout.constructor);
			byMethodName.set(stringIndex, list);
		}
		for (const key of layout.keys) {
			const id = coreClassLayoutKeyId(key);
			const list = byKey.get(id) ?? [];
			list.push(layout.constructor);
			byKey.set(id, list);
		}
	}
	return Object.freeze({
		layouts,
		ordinaryKeys: ordinaryDataKeys(program),
		methodClass,
		family,
		byMethodName,
		byKey,
	});
}
