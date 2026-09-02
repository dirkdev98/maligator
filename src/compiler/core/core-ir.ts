/**
 * Canonical middle-end IR.
 *
 * Core IR is block-based SSA. Every value and instruction has a stable,
 * function-local identity; blocks end in an explicit terminator; and opcode
 * semantics live in a single descriptor registry. The front end and VM are
 * deliberately outside this module.
 */

import { EFFECT_DOMAINS, NO_EFFECT_SUMMARY } from "../shared/effect-summary.ts";
import type { EffectDomain, EffectSummary } from "../shared/effect-summary.ts";

declare const coreFunctionIdBrand: unique symbol;
declare const coreBlockIdBrand: unique symbol;
declare const coreInstructionIdBrand: unique symbol;
declare const coreValueIdBrand: unique symbol;
declare const coreFactIdBrand: unique symbol;
declare const coreOpcodeIdBrand: unique symbol;

export type CoreFunctionId = number & { readonly [coreFunctionIdBrand]: true };
export type CoreBlockId = number & { readonly [coreBlockIdBrand]: true };
export type CoreInstructionId = number & {
	readonly [coreInstructionIdBrand]: true;
};
export type CoreValueId = number & { readonly [coreValueIdBrand]: true };
export type CoreFactId = number & { readonly [coreFactIdBrand]: true };
export type CoreOpcodeId = number & { readonly [coreOpcodeIdBrand]: true };

function checkedId(value: number, kind: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${kind} must be a non-negative safe integer, received ${value}`);
	}
	return value;
}

export function coreBlockId(value: number): CoreBlockId {
	return checkedId(value, "Core block id") as CoreBlockId;
}

export function coreFunctionId(value: number): CoreFunctionId {
	return checkedId(value, "Core function id") as CoreFunctionId;
}

export function coreInstructionId(value: number): CoreInstructionId {
	return checkedId(value, "Core instruction id") as CoreInstructionId;
}

export function coreValueId(value: number): CoreValueId {
	return checkedId(value, "Core value id") as CoreValueId;
}

export function coreFactId(value: number): CoreFactId {
	return checkedId(value, "Core fact id") as CoreFactId;
}

export function coreOpcodeId(value: number): CoreOpcodeId {
	return checkedId(value, "Core opcode id") as CoreOpcodeId;
}

/**
 * Core's effect vocabulary is the shared summary vocabulary. Instruction
 * descriptors and interprocedural summaries therefore speak in the same domains,
 * which is what lets a summary license an instruction refinement without a
 * translation step in between.
 */
export const CORE_EFFECT_DOMAINS = EFFECT_DOMAINS;

export type CoreEffectDomain = EffectDomain;

export type CoreInstructionEffects = EffectSummary;

export const CORE_NO_EFFECTS: CoreInstructionEffects = NO_EFFECT_SUMMARY;

/**
 * Memory families Core can name. Deliberately absent: strings, whose values are
 * immutable so there is no string memory to alias, and epochs, whose validity is
 * a fact-system property rather than a memory dependence.
 */
export const CORE_MEMORY_FAMILIES = [
	"global-slot",
	"global-property",
	"local-slot",
	"captured-slot",
	"activation-this",
	"object-slot",
	"element",
	"shape",
	"prototype",
] as const;

export type CoreMemoryFamily = (typeof CORE_MEMORY_FAMILIES)[number];

/**
 * Effect domains each family participates in. Families that can alias share a
 * domain, so an analysis never has to remember that `global-property` and
 * `object-slot` describe the same cells; invalidation flows through the shared
 * domain instead.
 */
export const CORE_MEMORY_FAMILY_DOMAINS: Readonly<
	Record<CoreMemoryFamily, ReadonlyArray<CoreEffectDomain>>
> = Object.freeze({
	"global-slot": Object.freeze<Array<CoreEffectDomain>>(["global-slot"]),
	"global-property": Object.freeze<Array<CoreEffectDomain>>([
		"global-property",
		"object-property",
	]),
	"local-slot": Object.freeze<Array<CoreEffectDomain>>(["local-slot"]),
	"captured-slot": Object.freeze<Array<CoreEffectDomain>>(["captured-slot"]),
	"activation-this": Object.freeze<Array<CoreEffectDomain>>(["activation-this"]),
	"object-slot": Object.freeze<Array<CoreEffectDomain>>(["object-property"]),
	element: Object.freeze<Array<CoreEffectDomain>>(["object-property", "array-element"]),
	shape: Object.freeze<Array<CoreEffectDomain>>(["object-property"]),
	prototype: Object.freeze<Array<CoreEffectDomain>>(["object-property"]),
});

/** Families addressed by compiler attributes alone, never by a heap base or key. */
export const CORE_ATTRIBUTE_ONLY_MEMORY_FAMILIES: ReadonlySet<CoreMemoryFamily> =
	new Set<CoreMemoryFamily>(["local-slot", "captured-slot", "activation-this"]);

export type CoreAccessMode = "read" | "write";

/**
 * How one opcode names the memory it touches. `attributes` lists the instruction
 * attributes that identify an exact cell inside the family; an access without
 * them covers the family as a whole. `baseOperand`, `keyAttribute`, and
 * `keyOperand` are declared for the alias oracle that narrows proven heap
 * locations. Attribute keys name interned strings; operand keys still need
 * `ToPropertyKey` normalization. Without a proof, either form remains
 * conservative at whole-family scope.
 */
export interface CoreOpcodeAccess {
	readonly family: CoreMemoryFamily;
	readonly mode: CoreAccessMode;
	readonly attributes?: ReadonlyArray<string>;
	readonly baseOperand?: number;
	readonly keyAttribute?: string;
	readonly keyOperand?: number;
	/** Operand holding the value a write stores, when the opcode has one. */
	readonly valueOperand?: number;
	/** This write creates the named own data cell instead of requiring it to exist. */
	readonly establishesOwnDataSlot?: boolean;
}

/**
 * Layout of a fresh aggregate whose own data slots this opcode initializes. Every
 * declared key is an own writable, enumerable, configurable data property of the
 * new object, and the operands starting at `firstValueOperand` hold their initial
 * values in the same order. Without this metadata an analysis has no way to know
 * a slot exists without consulting the runtime's shape tree.
 */
export type CoreOpcodeAllocation =
	| {
			readonly kind: "named-slots";
			readonly keysAttribute: string;
			readonly firstValueOperand: number;
	  }
	| {
			readonly kind: "indexed";
			readonly lengthAttribute: string;
			readonly initialElements: "none";
	  };

/**
 * How an opcode transfers control to a callable operand, and where its result
 * comes from.
 *
 * `calleeOperand` is the single declaration of which operand holds the callable,
 * so an analysis finds the callee without knowing the argument layout. The
 * result kinds follow the object internal methods rather than the syntax:
 *
 * - `call-completion` — the result is the callee's [[Call]] completion value.
 * - `construct-completion` — the result is [[Construct]]'s, which is an object
 *   the body returned explicitly or, for anything else it returned, the object
 *   [[Construct]] bound as `this`.
 * - `unmodeled` — control reaches the callable, but nothing here relates the
 *   result to what the callable returned.
 *
 * `invocation` and `arguments` describe how values enter the target frame. They
 * live beside the callee declaration so whole-program analyses cannot agree on
 * the call graph while silently disagreeing about parameter flow. A positional
 * list maps one-to-one onto source formals from `firstOperand`; an aggregate
 * list is dynamically expanded and therefore opens every formal. `receiverOperand`
 * is present only for [[Call]]. [[Construct]] creates its receiver internally.
 */
export interface CoreOpcodeCallTransfer {
	readonly calleeOperand: number;
	readonly result: "call-completion" | "construct-completion" | "unmodeled";
	readonly invocation: "call" | "construct";
	readonly receiverOperand?: number;
	readonly arguments:
		| {
				readonly kind: "positional";
				readonly firstOperand: number;
		  }
		| {
				readonly kind: "aggregate";
				readonly operand: number;
		  };
}

export interface CoreArity {
	readonly minimum: number;
	readonly maximum: number;
}

export function coreArity(exact: number): CoreArity;
export function coreArity(minimum: number, maximum: number): CoreArity;
export function coreArity(minimum: number, maximum = minimum): CoreArity {
	if (
		!Number.isSafeInteger(minimum) ||
		!Number.isSafeInteger(maximum) ||
		minimum < 0 ||
		maximum < minimum
	) {
		throw new Error(`Invalid Core IR arity ${minimum}..${maximum}`);
	}
	return Object.freeze({ minimum, maximum });
}

export interface CoreOpcodeDescriptor<Name extends string = string> {
	readonly id: CoreOpcodeId;
	readonly opcode: Name;
	readonly inputs: CoreArity;
	readonly outputs: CoreArity;
	readonly effects: CoreInstructionEffects;
	/** Removing an unused result cannot change observable JavaScript behavior. */
	readonly discardable: boolean;
	/**
	 * Memory this opcode names. The registry checks every access against
	 * `effects`, so a descriptor cannot name memory it does not declare an effect
	 * domain for and the two can never drift apart.
	 */
	readonly accesses?: ReadonlyArray<CoreOpcodeAccess>;
	/** Fresh aggregate this opcode produces, when its layout is compiler-known. */
	readonly allocation?: CoreOpcodeAllocation;
	/**
	 * Control transfer to a callable operand. Declaring it here is what keeps the
	 * callee-target lattice and the interprocedural call graph from maintaining
	 * separate ideas of which opcodes are calls.
	 */
	readonly callTransfer?: CoreOpcodeCallTransfer;
	/**
	 * Every operand is inspected without anything retaining it, so passing a
	 * reference here does not let it be reached again. Operators whose observation
	 * depends on an attribute — strict equality, `typeof` — are narrowed by the
	 * escape analysis instead, since a positional flag cannot express them.
	 */
	readonly observesOperands?: boolean;
	/**
	 * The result is neither an object nor a symbol, so `CanBeHeldWeakly` rejects it
	 * and no `WeakRef` or `FinalizationRegistry` can observe when it stops being
	 * reachable. A transform may only change how long such a value is referenced;
	 * for anything else, reachability is observable program behaviour.
	 */
	readonly resultCannotBeHeldWeakly?: boolean;
}

export type CoreOpcodeDefinition<Name extends string = string> = Omit<
	CoreOpcodeDescriptor<Name>,
	"id"
>;

function validateEffectDomains(
	opcode: string,
	kind: "read" | "write",
	domains: ReadonlyArray<CoreEffectDomain>,
): void {
	const seen = new Set<CoreEffectDomain>();
	for (const domain of domains) {
		if (!CORE_EFFECT_DOMAINS.includes(domain)) {
			throw new Error(`Unknown ${kind} effect domain ${domain} for ${opcode}`);
		}
		if (seen.has(domain)) {
			throw new Error(`Duplicate ${kind} effect domain ${domain} for ${opcode}`);
		}
		seen.add(domain);
	}
}

function validateAccesses(descriptor: CoreOpcodeDefinition): void {
	const opcode = descriptor.opcode;
	const seen: Array<readonly [CoreMemoryFamily, "read" | "write"]> = [];
	for (const access of descriptor.accesses ?? []) {
		if (!CORE_MEMORY_FAMILIES.includes(access.family)) {
			throw new Error(`Unknown memory family ${access.family} for ${opcode}`);
		}
		if (access.mode !== "read" && access.mode !== "write") {
			throw new Error(`Unknown access mode ${String(access.mode)} for ${opcode}`);
		}
		if (seen.some(([family, mode]) => family === access.family && mode === access.mode)) {
			throw new Error(
				`Duplicate ${access.mode} access to ${access.family} for ${opcode}`,
			);
		}
		seen.push([access.family, access.mode]);
		const declared =
			access.mode === "read" ? descriptor.effects.reads : descriptor.effects.writes;
		for (const domain of CORE_MEMORY_FAMILY_DOMAINS[access.family]) {
			if (!declared.includes(domain)) {
				throw new Error(
					`${opcode} ${access.mode}s ${access.family} without declaring the ${domain} effect domain`,
				);
			}
		}
		const attributes = access.attributes ?? [];
		if (attributes.some((attribute) => attribute.length === 0)) {
			throw new Error(`${opcode} names an empty ${access.family} attribute`);
		}
		if (new Set(attributes).size !== attributes.length) {
			throw new Error(`${opcode} repeats a ${access.family} attribute`);
		}
		if (
			CORE_ATTRIBUTE_ONLY_MEMORY_FAMILIES.has(access.family) &&
			(access.baseOperand !== undefined ||
				access.keyAttribute !== undefined ||
				access.keyOperand !== undefined)
		) {
			throw new Error(
				`${opcode} names a base or key for the activation-local family ${access.family}`,
			);
		}
		if (access.valueOperand !== undefined && access.mode !== "write") {
			throw new Error(`${opcode} names a value operand on a ${access.mode} access`);
		}
		if (access.keyAttribute !== undefined && access.keyOperand !== undefined) {
			throw new Error(`${opcode} names both a key attribute and a key operand`);
		}
		if (access.establishesOwnDataSlot === true && access.mode !== "write") {
			throw new Error(`${opcode} establishes an own data slot on a read access`);
		}
		for (const [role, operand] of [
			["base", access.baseOperand],
			["key", access.keyOperand],
			["value", access.valueOperand],
		] as const) {
			if (operand === undefined) continue;
			if (
				!Number.isSafeInteger(operand) ||
				operand < 0 ||
				operand >= descriptor.inputs.maximum
			) {
				throw new Error(
					`${opcode} names ${role} operand ${operand} outside its ${descriptor.inputs.minimum}..${descriptor.inputs.maximum} inputs`,
				);
			}
		}
	}
}

function validateCallTransfer(descriptor: CoreOpcodeDefinition): void {
	const transfer = descriptor.callTransfer;
	if (transfer === undefined) return;
	const opcode = descriptor.opcode;
	if (!descriptor.effects.callsUserCode) {
		throw new Error(`${opcode} declares a call transfer without entering user code`);
	}
	if (
		!Number.isSafeInteger(transfer.calleeOperand) ||
		transfer.calleeOperand < 0 ||
		transfer.calleeOperand >= descriptor.inputs.minimum
	) {
		throw new Error(
			`${opcode} names callee operand ${transfer.calleeOperand} outside its ${descriptor.inputs.minimum} required inputs`,
		);
	}
	if (transfer.result !== "unmodeled" && descriptor.outputs.minimum < 1) {
		throw new Error(`${opcode} declares a ${transfer.result} without producing a result`);
	}
	if (transfer.invocation === "call") {
		if (
			transfer.receiverOperand === undefined ||
			!Number.isSafeInteger(transfer.receiverOperand) ||
			transfer.receiverOperand < 0 ||
			transfer.receiverOperand >= descriptor.inputs.minimum
		) {
			throw new Error(`${opcode} declares [[Call]] without a required receiver operand`);
		}
	} else if (transfer.receiverOperand !== undefined) {
		throw new Error(`${opcode} declares a receiver operand for [[Construct]]`);
	}
	const argumentOperand =
		transfer.arguments.kind === "positional"
			? transfer.arguments.firstOperand
			: transfer.arguments.operand;
	if (
		!Number.isSafeInteger(argumentOperand) ||
		argumentOperand < 0 ||
		argumentOperand > descriptor.inputs.minimum ||
		(transfer.arguments.kind === "aggregate" &&
			argumentOperand >= descriptor.inputs.minimum)
	) {
		throw new Error(`${opcode} declares an invalid argument operand ${argumentOperand}`);
	}
}

function validateAllocation(descriptor: CoreOpcodeDefinition): void {
	const allocation = descriptor.allocation;
	if (allocation === undefined) return;
	const opcode = descriptor.opcode;
	if (descriptor.outputs.minimum < 1) {
		throw new Error(`${opcode} declares an allocation without producing a reference`);
	}
	if (allocation.kind === "named-slots") {
		if (allocation.keysAttribute.length === 0) {
			throw new Error(`${opcode} declares an allocation with no key attribute`);
		}
		if (
			!Number.isSafeInteger(allocation.firstValueOperand) ||
			allocation.firstValueOperand < 0 ||
			allocation.firstValueOperand > descriptor.inputs.maximum
		) {
			throw new Error(
				`${opcode} declares initial values at operand ${allocation.firstValueOperand}, outside its ${descriptor.inputs.minimum}..${descriptor.inputs.maximum} inputs`,
			);
		}
		return;
	}
	if (allocation.lengthAttribute.length === 0) {
		throw new Error(`${opcode} declares an indexed allocation with no length attribute`);
	}
}

export class CoreOpcodeRegistry {
	readonly #descriptors = new Map<string, CoreOpcodeDescriptor>();
	readonly #descriptorsById: Array<CoreOpcodeDescriptor> = [];

	define<const Name extends string>(
		descriptor: CoreOpcodeDefinition<Name>,
	): CoreOpcodeDescriptor<Name> {
		if (descriptor.opcode.length === 0) throw new Error("Core opcode cannot be empty");
		if (this.#descriptors.has(descriptor.opcode)) {
			throw new Error(`Duplicate Core opcode ${descriptor.opcode}`);
		}
		validateEffectDomains(descriptor.opcode, "read", descriptor.effects.reads);
		validateEffectDomains(descriptor.opcode, "write", descriptor.effects.writes);
		validateAccesses(descriptor);
		validateAllocation(descriptor);
		validateCallTransfer(descriptor);
		const frozen: CoreOpcodeDescriptor<Name> = Object.freeze({
			...descriptor,
			id: coreOpcodeId(this.#descriptorsById.length),
			inputs: Object.freeze({ ...descriptor.inputs }),
			outputs: Object.freeze({ ...descriptor.outputs }),
			effects: Object.freeze({
				...descriptor.effects,
				reads: Object.freeze([...descriptor.effects.reads]),
				writes: Object.freeze([...descriptor.effects.writes]),
			}),
			...(descriptor.allocation === undefined
				? {}
				: { allocation: Object.freeze({ ...descriptor.allocation }) }),
			...(descriptor.callTransfer === undefined
				? {}
				: { callTransfer: Object.freeze({ ...descriptor.callTransfer }) }),
			...(descriptor.accesses === undefined
				? {}
				: {
						accesses: Object.freeze(
							descriptor.accesses.map((access) =>
								Object.freeze({
									...access,
									...(access.attributes === undefined
										? {}
										: { attributes: Object.freeze([...access.attributes]) }),
								}),
							),
						),
					}),
		});
		this.#descriptors.set(descriptor.opcode, frozen);
		this.#descriptorsById.push(frozen);
		return frozen;
	}

	get(opcode: string): CoreOpcodeDescriptor | undefined {
		return this.#descriptors.get(opcode);
	}

	require(opcode: string): CoreOpcodeDescriptor {
		const descriptor = this.get(opcode);
		if (descriptor === undefined) throw new Error(`Unknown Core opcode ${opcode}`);
		return descriptor;
	}

	byId(id: CoreOpcodeId): CoreOpcodeDescriptor {
		const descriptor = this.#descriptorsById[id];
		if (descriptor === undefined || descriptor.id !== id) {
			throw new Error(`Unknown Core opcode id ${id}`);
		}
		return descriptor;
	}

	entries(): ReadonlyArray<CoreOpcodeDescriptor> {
		return [...this.#descriptorsById];
	}
}

export type CoreRepresentation =
	| "boxed"
	| "f64"
	| "i32"
	| "boolean"
	| "string"
	| "string-span"
	| "projected-elements"
	| "dense-elements"
	| "scalarized-object";

export type CoreFactValidity =
	| { readonly kind: "world"; readonly fact: string }
	| { readonly kind: "epoch"; readonly family: string }
	| { readonly kind: "guard"; readonly instruction: CoreInstructionId }
	| { readonly kind: "summary"; readonly digest: string }
	| { readonly kind: "asserted"; readonly source: string };

export type CoreFactObligation =
	| { readonly kind: "guard"; readonly instruction: CoreInstructionId }
	| { readonly kind: "fallback"; readonly id: string }
	| { readonly kind: "materialize"; readonly id: string };

/**
 * A semantic statement a Core fact establishes. Claims are deliberately small,
 * closed lattices: implication is decidable without interpreting a producer's
 * descriptive `kind`/`value` payload.
 *
 * A claim carries no program point of its own. A claim about a subject value
 * holds wherever the fact is available and that value is already defined; a
 * claim about an instruction is pinned to that instruction.
 */
export type CoreFactClaim =
	| {
			readonly kind: "identity";
			readonly subject: CoreValueId;
			/** Finite identities still possible; a smaller set is a stronger fact. */
			readonly identities: ReadonlyArray<string | number | boolean | null>;
	  }
	| {
			readonly kind: "shape";
			readonly subject: CoreValueId;
			/** Stable shape identifiers still possible; a smaller set is stronger. */
			readonly shapes: ReadonlyArray<string>;
	  }
	| {
			/**
			 * The subject is one of: a value in `[minimum, maximum]` (restricted to
			 * integers when `integer`), NaN when `mayBeNaN`, or `-0` when
			 * `mayBeNegativeZero`. The reading is a disjunction, not a filter over the
			 * interval: `-0` and NaN membership is decided by the flag alone, because
			 * `-0` compares equal to `0` and NaN compares false against both bounds.
			 * A claim no value satisfies is invalid — it would imply every claim about
			 * its subject. Canonical form is defined by `canonicalRangeBounds`.
			 */
			readonly kind: "range";
			readonly subject: CoreValueId;
			/** `null` is the corresponding unbounded end, as is that infinity. */
			readonly minimum: number | null;
			readonly maximum: number | null;
			readonly integer: boolean;
			readonly mayBeNaN: boolean;
			readonly mayBeNegativeZero: boolean;
	  }
	| {
			/**
			 * Upper bound on everything the named instruction may do. The claim goes
			 * inert rather than invalid when a transform deletes that instruction, so
			 * only a live consumer of the fact has to be covered by it.
			 */
			readonly kind: "effect";
			readonly instruction: CoreInstructionId;
			readonly effects: CoreInstructionEffects;
	  };

export interface CoreFact {
	readonly id: CoreFactId;
	readonly kind: string;
	readonly value: unknown;
	readonly claims: ReadonlyArray<CoreFactClaim>;
	readonly validity: CoreFactValidity;
	readonly obligations: ReadonlyArray<CoreFactObligation>;
	readonly origin: string;
}

export type CoreValueDefinition =
	| {
			readonly kind: "block-parameter";
			readonly block: CoreBlockId;
			readonly index: number;
	  }
	| {
			readonly kind: "instruction";
			readonly instruction: CoreInstructionId;
			readonly index: number;
	  };

export interface CoreEffectRefinement {
	readonly effects: CoreInstructionEffects;
	readonly proof: CoreFactId;
}

export type CoreAttributeValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<CoreAttributeValue>
	| CoreAttributeObject;

export interface CoreAttributeObject {
	readonly [key: string]: CoreAttributeValue;
}

export type CoreInstructionAttributes = Readonly<Record<string, CoreAttributeValue>>;

export interface CoreBlockParameter {
	readonly value: CoreValueId;
	readonly representation: CoreRepresentation;
	readonly role: "value" | "exception";
}

export interface CoreEdge {
	readonly block: CoreBlockId;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export type CoreImmediate =
	| { readonly kind: "undefined" }
	| { readonly kind: "null" }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "string"; readonly index: number };

export type CoreTerminatorPayload =
	| { readonly kind: "jump"; readonly edge: CoreEdge }
	| {
			readonly kind: "branch";
			readonly condition: CoreValueId;
			readonly consequent: CoreEdge;
			readonly alternate: CoreEdge;
	  }
	| {
			readonly kind: "guard";
			readonly condition: CoreValueId;
			readonly fact: CoreFactId;
			readonly success: CoreEdge;
			readonly fallback: CoreEdge;
	  }
	| {
			readonly kind: "switch";
			readonly discriminant: CoreValueId;
			readonly cases: ReadonlyArray<{
				readonly value: CoreImmediate;
				readonly edge: CoreEdge;
			}>;
			readonly default: CoreEdge;
	  }
	| { readonly kind: "return"; readonly value: CoreValueId }
	| { readonly kind: "throw"; readonly value: CoreValueId }
	| { readonly kind: "unreachable" };

export type CoreTerminatorInput = CoreTerminatorPayload extends infer Terminator
	? Terminator extends CoreTerminatorPayload
		? Terminator & { readonly sourcePosition?: number }
		: never
	: never;

export interface CoreExceptionHandler {
	readonly block: CoreBlockId;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

export interface CoreFunctionMetadata {
	readonly sourcePath: string;
	readonly sourceStrict: boolean;
	readonly nameStringIndex: number;
	readonly length: number;
	readonly mappedArguments: boolean;
	readonly mappedArgumentSlots: ReadonlyArray<number>;
	readonly capturedCount: number;
	readonly strict: boolean;
	readonly isClassConstructor: boolean;
	readonly isDerivedConstructor: boolean;
	readonly hasPrototype: boolean;
}

export interface CoreBlockParameterSpec {
	readonly representation?: CoreRepresentation;
	readonly role?: "value" | "exception";
}

export interface CoreFunctionOptions {
	readonly isGenerator?: boolean;
	readonly isAsync?: boolean;
	readonly parameterCount?: number;
	readonly metadata?: Partial<CoreFunctionMetadata>;
}

export interface AppendCoreInstructionOptions {
	readonly outputCount?: number;
	readonly outputRepresentations?: ReadonlyArray<CoreRepresentation>;
	readonly attributes?: CoreInstructionAttributes;
	readonly sourcePosition?: number;
	readonly effectRefinement?: CoreEffectRefinement;
}

export interface SetCoreGuardTerminatorInput {
	readonly condition: CoreValueId;
	readonly success: CoreEdge;
	readonly fallback: CoreEdge;
	readonly sourcePosition?: number;
	readonly fact: Omit<CoreFact, "id" | "validity" | "obligations"> & {
		readonly obligations?: ReadonlyArray<
			Exclude<CoreFactObligation, { readonly kind: "guard" }>
		>;
	};
}

export { CoreFunctionStore, CoreProgram } from "./core-store.ts";
export type {
	CoreChangeDomain,
	CoreChangeSet,
	CoreChangedEdge,
	CoreBlockLayout,
	CoreEffectRefinementLayout,
	CoreFunctionVersions,
	CoreInstructionLayout,
	CoreInstructionKind,
	CoreProgramDataTables,
	CoreProgramVersions,
	CoreUse,
	CoreUseLayout,
	CoreValueLayout,
	SealedCoreProgram,
} from "./core-store.ts";
export { CoreEditor } from "./core-editor.ts";
export { CoreFunctionBuilder } from "./core-builder.ts";
export { formatCoreFunction, formatCoreProgram } from "./core-format.ts";
