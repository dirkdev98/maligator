import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "../shared/compiler-value-kinds.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CorePrivateFieldKeys } from "./core-private-field-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

// Keys whose property names are canonical numeric strings or words that name
// neither the prototype nor an Array.prototype method.
const SAFE_KEY_KINDS =
	COMPILER_VALUE_KIND_NUMBER |
	COMPILER_VALUE_KIND_BIGINT |
	COMPILER_VALUE_KIND_BOOLEAN |
	COMPILER_VALUE_KIND_NULL |
	COMPILER_VALUE_KIND_UNDEFINED;

// Array.prototype methods that leave the receiver's elements among the values it
// already held, and only read or convert their arguments.
const READING_METHODS: ReadonlySet<string> = new Set([
	"at",
	"concat",
	"copyWithin",
	"entries",
	"flat",
	"includes",
	"indexOf",
	"join",
	"keys",
	"lastIndexOf",
	"pop",
	"reverse",
	"shift",
	"slice",
	"sort",
	"toString",
	"values",
]);

// The argument range each storing method writes into its receiver.
const STORING_METHODS: ReadonlyMap<string, readonly [number, number]> = new Map([
	["fill", [0, 1]],
	["push", [0, Infinity]],
	["splice", [2, Infinity]],
	["unshift", [0, Infinity]],
]);

// The parameter position at which each callback method passes its receiver.
const CALLBACK_METHODS: ReadonlyMap<string, number> = new Map([
	["every", 2],
	["filter", 2],
	["find", 2],
	["findIndex", 2],
	["findLast", 2],
	["findLastIndex", 2],
	["flatMap", 2],
	["forEach", 2],
	["map", 2],
	["reduce", 3],
	["reduceRight", 3],
	["some", 2],
]);

// Operations through which a function can reach arguments it declares no parameter for.
const ARGUMENT_READERS: ReadonlySet<string> = new Set([
	"callRestArguments",
	"createArgumentsObject",
	"createRestArguments",
	"createRestArgumentsState",
	"loadArgument",
	"loadArgumentCount",
	"loadStaticArgument",
]);

type ArrayMethod =
	| { readonly kind: "reading" }
	| { readonly kind: "storing"; readonly range: readonly [number, number] }
	| { readonly kind: "callback"; readonly arrayParameter: number };

interface ElementWrite {
	readonly nodes: ReadonlyArray<number>;
	readonly value: CoreValueId;
}

interface KeyedElementWrite extends ElementWrite {
	readonly key: CoreValueId;
}

/** One function's accesses to arrays that private fields may hold. */
export interface CorePrivateElementFunction {
	readonly fn: CoreFunctionStore;
	readonly control: CoreControlFlow;
	readonly writes: ReadonlyArray<ElementWrite>;
	/** Stores that write only elements or harmless names while their key's kind is safe. */
	readonly keyed: ReadonlyArray<KeyedElementWrite>;
	/** Keyed reads from such arrays and the holders their receiver comes from. */
	readonly loads: ReadonlyMap<CoreInstructionId, ReadonlyArray<number>>;
}

function operand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function result(fn: CoreFunctionStore, instruction: CoreInstructionId): CoreValueId {
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
}

function unmoved(fn: CoreFunctionStore, value: CoreValueId): CoreValueId {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return value;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return value;
		value = operand(fn, instruction, 0);
	}
	return value;
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	value = unmoved(fn, value);
	return fn.kernel.valueDefinitionKind(value) === 1 &&
		fn.instructionOpcodeName(coreInstructionId(fn.kernel.valueDefinitionOwner(value))) !==
			"move"
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

/** Whether `value` is always `undefined` or `null`. */
export function coreValueIsNullishConstant(
	fn: CoreFunctionStore,
	value: CoreValueId,
): boolean {
	const source = definition(fn, value);
	if (source === undefined) return false;
	const opcode = fn.instructionOpcodeName(source);
	return opcode === "createUndefined" || opcode === "createNull";
}

function stringConstant(program: CoreProgram, index: unknown): string | undefined {
	if (typeof index !== "number") return undefined;
	const units = program.stringConstants[index];
	return units === undefined ? undefined : String.fromCharCode(...units);
}

/**
 * Element kinds of the Arrays that class-private fields hold. Holders are fields
 * and the allocations stored into them; holders that can share an array are
 * merged. A holder's arrays have known elements only while every value that can
 * reference them stays in code that the scan sees: element reads and writes,
 * `length`, Array.prototype methods with locked primordials, iteration and
 * identity tests. Anything else, such as an argument, a return, a capture or a
 * store into an ordinary property, gives the holder unknown elements.
 */
export class CorePrivateFieldElements {
	readonly #program: CoreProgram;
	readonly #keys: CorePrivateFieldKeys;
	readonly #arrayKeys: ReadonlySet<string>;
	readonly #nodes = new Map<string, number>();
	readonly #parent: Array<number> = [];
	readonly #elements: Array<CompilerValueKindMask> = [];
	readonly #escaped: Array<boolean> = [];
	readonly #copies: Array<{
		readonly from: ReadonlyArray<number>;
		readonly to: number;
	}> = [];
	// Holders that escape whenever one of `from` does.
	readonly #dependents: Array<{
		readonly from: ReadonlyArray<number>;
		readonly to: ReadonlyArray<number>;
	}> = [];
	readonly functions: Array<CorePrivateElementFunction> = [];

	constructor(
		program: CoreProgram,
		keys: CorePrivateFieldKeys,
		arrayKeys: ReadonlySet<string>,
	) {
		this.#program = program;
		this.#keys = keys;
		this.#arrayKeys = arrayKeys;
	}

	#node(name: string): number {
		let node = this.#nodes.get(name);
		if (node === undefined) {
			node = this.#parent.length;
			this.#nodes.set(name, node);
			this.#parent.push(node);
			this.#elements.push(0);
			this.#escaped.push(false);
		}
		return node;
	}

	#find(node: number): number {
		while (this.#parent[node] !== node) {
			const parent = this.#parent[node]!;
			this.#parent[node] = this.#parent[parent]!;
			node = parent;
		}
		return node;
	}

	#union(left: number, right: number): void {
		const a = this.#find(left),
			b = this.#find(right);
		if (a === b) return;
		this.#parent[b] = a;
		this.#elements[a] = this.#elements[a]! | this.#elements[b]!;
		this.#escaped[a] = this.#escaped[a]! || this.#escaped[b]!;
	}

	/** The property a static or string-keyed access names. */
	#staticName(fn: CoreFunctionStore, instruction: CoreInstructionId): string | undefined {
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "loadPropertyStatic" || opcode === "storePropertyStatic")
			return stringConstant(
				this.#program,
				fn.instructionAttributes(instruction).stringIndex,
			);
		if (opcode !== "loadProperty" && opcode !== "storeProperty") return undefined;
		const key = definition(fn, operand(fn, instruction, 1));
		return key !== undefined && fn.instructionOpcodeName(key) === "createString"
			? stringConstant(this.#program, fn.instructionAttributes(key).stringIndex)
			: undefined;
	}

	#escape(nodes: Iterable<number>): void {
		for (const node of nodes) this.#escaped[this.#find(node)] = true;
	}

	#join(nodes: Iterable<number>, mask: CompilerValueKindMask): boolean {
		let changed = false;
		for (const node of nodes) {
			const root = this.#find(node);
			if (this.#escaped[root] || (this.#elements[root]! | mask) === this.#elements[root])
				continue;
			this.#elements[root] = this.#elements[root]! | mask;
			changed = true;
		}
		return changed;
	}

	/** Element kinds a numeric-key read through any of `nodes` can return. */
	loadMask(nodes: ReadonlyArray<number>): CompilerValueKindMask | undefined {
		let mask: CompilerValueKindMask = COMPILER_VALUE_KIND_UNDEFINED;
		for (const node of nodes) {
			const root = this.#find(node);
			if (this.#escaped[root]) return undefined;
			mask |= this.#elements[root]!;
		}
		return mask;
	}

	/** Element kinds of the arrays a field holds, or undefined when they are unknown. */
	elements(key: string): CompilerValueKindMask | undefined {
		const node = this.#nodes.get(`k:${key}`);
		return node === undefined ? undefined : this.loadMask([node]);
	}

	/**
	 * Joins the kinds `mask` gives each recorded write; true when an element kind
	 * or an escape changed.
	 */
	update(
		record: CorePrivateElementFunction,
		mask: (value: CoreValueId) => CompilerValueKindMask,
	): boolean {
		let changed = false;
		for (const write of record.writes)
			changed = this.#join(write.nodes, mask(write.value)) || changed;
		for (const write of record.keyed) {
			if ((mask(write.key) & ~SAFE_KEY_KINDS) !== 0) {
				if (write.nodes.some((node) => !this.#escaped[this.#find(node)])) {
					this.#escape(write.nodes);
					changed = true;
				}
				continue;
			}
			changed = this.#join(write.nodes, mask(write.value)) || changed;
		}
		return changed;
	}

	/**
	 * Gives each spread copy the elements of the arrays it copies and escapes the
	 * dependents of escaped holders; true on change.
	 */
	propagate(): boolean {
		let changed = false;
		for (const { from, to } of this.#dependents)
			if (
				from.some((node) => this.#escaped[this.#find(node)]) &&
				to.some((node) => !this.#escaped[this.#find(node)])
			) {
				this.#escape(to);
				changed = true;
			}
		for (const { from, to } of this.#copies) {
			const elements = this.loadMask(from);
			if (elements === undefined) {
				if (!this.#escaped[this.#find(to)]) {
					this.#escape([to]);
					changed = true;
				}
			} else changed = this.#join([to], elements) || changed;
		}
		return changed;
	}

	/**
	 * Records how `fn` uses arrays that private fields can hold. A write that some
	 * read can observe and that stores an array the scan cannot follow from its
	 * allocation gives its field unknown elements.
	 */
	scan(
		fn: CoreFunctionStore,
		control: () => CoreControlFlow,
		observableWrite: (instruction: CoreInstructionId) => boolean,
	): void {
		const seeds: Array<readonly [CoreValueId, number]> = [];
		const allocations: Array<CoreInstructionId> = [];
		const fieldWrites: Array<readonly [CoreInstructionId, string]> = [];
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			if (opcode === "loadPrivate") {
				const key = this.#keys.key(fn, operand(fn, instruction, 1));
				if (key !== undefined && this.#arrayKeys.has(key))
					seeds.push([result(fn, instruction), this.#node(`k:${key}`)]);
			} else if (opcode === "createArray" || opcode === "createArrayFromIterable") {
				allocations.push(instruction);
			} else if (opcode === "storePrivate" || opcode === "definePrivate") {
				const key = this.#keys.key(fn, operand(fn, instruction, 1));
				if (key !== undefined && this.#arrayKeys.has(key))
					fieldWrites.push([instruction, key]);
			}
		}
		if (seeds.length === 0 && fieldWrites.length === 0) return;
		if (fieldWrites.length > 0)
			for (const instruction of allocations)
				seeds.push([result(fn, instruction), this.#node(`a:${fn.id}:${instruction}`)]);
		const cfg = control();

		const flows = new Map<CoreValueId, Array<CoreValueId>>();
		const flow = (from: CoreValueId, to: CoreValueId) => {
			const targets = flows.get(from);
			if (targets === undefined) flows.set(from, [to]);
			else targets.push(to);
		};
		const incoming = new Map<CoreValueId, Array<CoreValueId>>();
		for (const block of fn.blockIds()) {
			const edges = cfg.predecessors[block] ?? [];
			const start = fn.kernel.blockParameterStart(block);
			for (let index = 0; index < fn.kernel.blockParameterCount(block); index++) {
				const row = start + index;
				if (fn.kernel.blockParameterRole(row) === 1) continue;
				const parameter = fn.kernel.blockParameterValue(row);
				const sources: Array<CoreValueId> = [];
				for (const edge of edges) {
					const argument =
						edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
					if (argument === undefined) continue;
					sources.push(argument);
					flow(argument, parameter);
				}
				incoming.set(parameter, sources);
			}
		}
		for (const instruction of fn.instructionIds())
			if (
				fn.instructionKind(instruction) === "operation" &&
				fn.instructionOpcodeName(instruction) === "move" &&
				fn.kernel.instructionResultCount(instruction) === 1
			)
				flow(operand(fn, instruction, 0), result(fn, instruction));

		const origins = new Map<CoreValueId, Set<number>>();
		const pending: Array<CoreValueId> = [];
		const reach = (value: CoreValueId, nodes: Iterable<number>) => {
			let set = origins.get(value);
			let grew = false;
			for (const node of nodes) {
				if (set === undefined) origins.set(value, (set = new Set()));
				if (set.has(node)) continue;
				set.add(node);
				grew = true;
			}
			if (grew) pending.push(value);
		};
		for (const [value, node] of seeds) reach(value, [node]);
		while (pending.length > 0) {
			const value = pending.pop()!;
			for (const target of flows.get(value) ?? []) reach(target, origins.get(value)!);
		}
		// A join that can also receive a value the scan cannot follow holds unknown arrays.
		const mixed = new Set<CoreValueId>();
		for (const [parameter, sources] of incoming)
			if (origins.has(parameter) && sources.some((source) => !origins.has(source)))
				mixed.add(parameter);
		pending.push(...mixed);
		while (pending.length > 0) {
			const value = pending.pop()!;
			for (const target of flows.get(value) ?? [])
				if (!mixed.has(target)) {
					mixed.add(target);
					pending.push(target);
				}
		}
		const tracked = (value: CoreValueId) => origins.get(value);
		const exact = (value: CoreValueId) =>
			mixed.has(value) ? undefined : (origins.get(value) ?? undefined);

		const writes: Array<ElementWrite> = [];
		const keyed: Array<KeyedElementWrite> = [];
		const loads = new Map<CoreInstructionId, ReadonlyArray<number>>();
		const methods = new Map<CoreInstructionId, ArrayMethod | undefined>();
		const method = (instruction: CoreInstructionId): ArrayMethod | undefined => {
			if (methods.has(instruction)) return methods.get(instruction);
			const known = arrayMethod(instruction);
			methods.set(instruction, known);
			return known;
		};
		const arrayMethod = (instruction: CoreInstructionId): ArrayMethod | undefined => {
			const callee = definition(fn, operand(fn, instruction, 0));
			const name = callee === undefined ? undefined : this.#staticName(fn, callee);
			if (callee === undefined || name === undefined) return undefined;
			const base = operand(fn, callee, 0);
			const holders = exact(base);
			if (holders === undefined) return undefined;
			const range = STORING_METHODS.get(name);
			const arrayParameter = CALLBACK_METHODS.get(name);
			if (
				!READING_METHODS.has(name) &&
				range === undefined &&
				arrayParameter === undefined
			)
				return undefined;
			// The method is Array.prototype's only while no holder of the base's arrays
			// escapes to code that could give one an own property of that name.
			const to: Array<number> = [];
			const count = fn.kernel.instructionOperandCount(instruction);
			for (let position = 1; position < count; position++) {
				const value = operand(fn, instruction, position);
				if (position === 1 && unmoved(fn, value) === unmoved(fn, base)) continue;
				for (const node of tracked(value) ?? []) to.push(node);
			}
			if (to.length > 0) this.#dependents.push({ from: [...holders], to });
			if (range !== undefined) return { kind: "storing", range };
			return arrayParameter === undefined
				? { kind: "reading" }
				: { kind: "callback", arrayParameter };
		};
		const blindCallback = (value: CoreValueId, arrayParameter: number): boolean => {
			const creation = definition(fn, value);
			if (
				creation === undefined ||
				fn.instructionOpcodeName(creation) !== "createFunction"
			)
				return false;
			const target = fn.instructionAttributes(creation).functionIndex;
			if (typeof target !== "number") return false;
			const callback = this.#program.function(coreFunctionId(target));
			if (callback.parameterCount > arrayParameter) return false;
			for (const instruction of callback.instructionIds())
				if (
					callback.instructionKind(instruction) === "operation" &&
					ARGUMENT_READERS.has(callback.instructionOpcodeName(instruction))
				)
					return false;
			return true;
		};
		const escapes = new Set<number>();
		const use = (
			instruction: CoreInstructionId,
			position: number,
			nodes: Set<number>,
		) => {
			const opcode = fn.instructionOpcodeName(instruction);
			const value = operand(fn, instruction, position);
			switch (opcode) {
				case "move":
				case "rootUse":
				case "throwIfTdz":
				case "isEmpty":
				case "typeofCompare":
				case "loadPropertyStatic":
				case "loadPrivate":
				case "hasPrivate":
				case "getIterator":
				case "deleteProperty":
					return;
				case "loadProperty":
					if (position !== 0) break;
					if (exact(value) !== undefined) loads.set(instruction, [...nodes]);
					return;
				case "storeProperty":
				case "defineProperty":
					if (position !== 0 || fn.kernel.instructionOperandCount(instruction) !== 3)
						break;
					if (this.#staticName(fn, instruction) === "length") return;
					keyed.push({
						nodes: [...nodes],
						key: operand(fn, instruction, 1),
						value: operand(fn, instruction, 2),
					});
					return;
				case "storePropertyStatic":
					if (position === 0 && this.#staticName(fn, instruction) === "length") return;
					break;
				case "storePrivate":
				case "definePrivate":
					if (position === 0) return;
					if (position === 2) {
						const key = this.#keys.key(fn, operand(fn, instruction, 1));
						if (key !== undefined && this.#arrayKeys.has(key)) return;
					}
					break;
				case "createArrayFromIterable": {
					const copied = exact(value);
					const to = this.#nodes.get(`a:${fn.id}:${instruction}`);
					if (to === undefined) return;
					if (copied === undefined) this.#escape([to]);
					else this.#copies.push({ from: [...copied], to });
					return;
				}
				case "binary": {
					const operator = fn.instructionAttributes(instruction).operator;
					if (operator === "===" || operator === "!==") return;
					break;
				}
				case "unary": {
					const operator = fn.instructionAttributes(instruction).operator;
					if (operator === "!" || operator === "typeof" || operator === "void") return;
					break;
				}
				case "call": {
					if (position === 0) return;
					const known = method(instruction);
					if (known === undefined) break;
					const argument = position - 2;
					if (known.kind === "reading") return;
					if (known.kind === "storing") {
						const [start, end] = known.range;
						if (argument >= start && argument < end) break;
						if (position !== 1) return;
						const count = fn.kernel.instructionOperandCount(instruction);
						for (let index = start + 2; index < Math.min(count, end + 2); index++)
							writes.push({
								nodes: [...nodes],
								value: operand(fn, instruction, index),
							});
						return;
					}
					if (position === 1) {
						if (
							fn.kernel.instructionOperandCount(instruction) > 2 &&
							blindCallback(operand(fn, instruction, 2), known.arrayParameter)
						)
							return;
						break;
					}
					if (argument === 0) return;
					break;
				}
			}
			for (const node of nodes) escapes.add(node);
		};
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const count = fn.kernel.instructionOperandCount(instruction);
			for (let position = 0; position < count; position++) {
				const nodes = tracked(operand(fn, instruction, position));
				if (nodes !== undefined) use(instruction, position, nodes);
			}
		}
		for (const block of fn.blockIds()) {
			const input = coreTerminatorInput(fn, fn.blockTerminator(block));
			if (input.kind !== "return" && input.kind !== "throw") continue;
			const nodes = tracked(input.value);
			if (nodes !== undefined) for (const node of nodes) escapes.add(node);
		}
		for (const [instruction, key] of fieldWrites) {
			const field = this.#node(`k:${key}`);
			const value = operand(fn, instruction, 2);
			const nodes = tracked(value);
			if (nodes !== undefined) for (const node of nodes) this.#union(field, node);
			if (
				(nodes === undefined || mixed.has(value)) &&
				observableWrite(instruction) &&
				!coreValueIsNullishConstant(fn, value)
			)
				this.#escape([field]);
		}
		for (const instruction of allocations) {
			const node = this.#nodes.get(`a:${fn.id}:${instruction}`);
			if (
				node === undefined ||
				fn.instructionOpcodeName(instruction) !== "createArrayFromIterable"
			)
				continue;
			if (!tracked(operand(fn, instruction, 0))) this.#escape([node]);
		}
		this.#escape(escapes);
		if (writes.length > 0 || keyed.length > 0 || loads.size > 0)
			this.functions.push({ fn, control: cfg, writes, keyed, loads });
	}
}
