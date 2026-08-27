/**
 * Allocation provenance and escape for fresh aggregates with a compiler-known
 * layout.
 *
 * Both analyses are ordinary SSA dataflow over the registry's declarations, not
 * opcode patterns. Provenance is must-alias: a value belongs to an allocation
 * only when `coreCanonicalValueRoots` collapses it to that allocation's output,
 * which already handles moves and single-producer block parameters. Escape is a
 * single sweep over every use, because an allocation is disqualified by the
 * syntactic form of its uses rather than by anything that propagates.
 *
 * The escape lattice is two-valued and one-way, so the sweep is a fixed point by
 * construction: `contained` becomes `escaped` and never returns. Cost is
 * O(instructions + edges + values).
 */

import { coreCanonicalValueRoots, coreTerminatorEdges } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import {
	CORE_CALL_SUMMARY_ATTRIBUTE,
	coreCallSummaryClaimFromAttribute,
} from "./core-ir-summaries.ts";
import type { CoreCallValueSummaryClaim } from "./core-ir-summaries.ts";
import { CORE_MEMORY_FAMILY_DOMAINS } from "./core-ir.ts";
import type {
	CoreAccessMode,
	CoreBlockId,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreOpcodeAccess,
	CoreValueId,
} from "./core-ir.ts";

/**
 * Fact kind a pass attaches when it narrows a property access to a contained own
 * data slot. The verifier re-proves exactly this kind, so a future guarded or
 * epoch refinement of the same opcode is not held to a containment it never
 * claimed.
 */
export const CORE_OWN_DATA_CELL_FACT = "own-data-cell";

/** A static own slot shared by every stable shaped object held in a private
 * contained aggregate. The verifier reconstructs the ownership, value-flow,
 * and in-bounds proofs before lowering may consume the physical slot. */
export const CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT = "contained-aggregate-own-slot";

/** Fresh-Array length load whose Number result and exact receiver brand were
 * independently re-proved. Lowering consumes this as native authority. */
export const CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE = "freshArrayLengthNumber";

/** Numeric element read on an initially dense fresh Array whose complete
 * lifetime is restricted to dense push/pop, length, and numeric reads. */
export const CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE =
	"containedDenseArrayElementRead";

/** Key spelling carried by an opcode before `ToPropertyKey` normalization. */
export type CoreAccessKey =
	| { readonly kind: "string-constant"; readonly index: number }
	| { readonly kind: "operand"; readonly value: CoreValueId };

/** Canonical own cell identity after numeric and string key spellings converge. */
export type CoreOwnCell =
	| { readonly kind: "object-slot"; readonly key: number }
	| { readonly kind: "element"; readonly index: number };

/**
 * A fresh ordinary object whose own data slots Core knows exactly. Every key is
 * an own writable data property from the moment the object exists, so an access
 * naming one of them consults no prototype, accessor, or Proxy trap.
 */
interface CoreAllocationLayoutBase {
	readonly instruction: CoreInstructionId;
	readonly result: CoreValueId;
	readonly kind: "named-slots" | "indexed";
}

export interface CoreNamedAllocationLayout extends CoreAllocationLayoutBase {
	readonly kind: "named-slots";
	/** Own data keys as string-constant indices, in slot order. */
	readonly keys: ReadonlyArray<number>;
	/** Initial value of each key, in the same order. */
	readonly initialValues: ReadonlyArray<CoreValueId>;
}

export interface CoreArrayElementLayout {
	readonly index: number;
	readonly value: CoreValueId;
	/** The own-data define that makes this non-hole element present. */
	readonly definition: CoreInstructionId;
}

export interface CoreIndexedAllocationLayout extends CoreAllocationLayoutBase {
	readonly kind: "indexed";
	readonly length: number;
	/** Elements proven present, keyed by their canonical array index. */
	readonly elements: ReadonlyMap<number, CoreArrayElementLayout>;
}

export type CoreAllocationLayout =
	| CoreNamedAllocationLayout
	| CoreIndexedAllocationLayout;

/**
 * `contained` means no reference to the object can be reached from outside this
 * activation and every operation on it names one of its own data slots. That is
 * the condition under which the object's shape is fixed for its whole lifetime,
 * which in turn is what lets a slot access skip accessor, Proxy, and
 * shape-mutation semantics.
 */
export type CoreAllocationEscape = "contained" | "escaped";

export interface CoreProvenance {
	/** Layouts in instruction order; only allocations Core can describe exactly. */
	readonly layouts: ReadonlyArray<CoreAllocationLayout>;
	/** Layout a value must refer to, when one allocation must-alias it. */
	allocationOf(value: CoreValueId): CoreAllocationLayout | undefined;
	escape(allocation: CoreInstructionId): CoreAllocationEscape;
	/** Re-evaluate only the escape/use policy while reusing canonical SSA roots,
	 * allocation layouts, definitions, and key normalization from this analysis. */
	withAssumedNonEscapingOperands(
		assumptions: ReadonlyMap<CoreInstructionId, ReadonlySet<number>>,
	): CoreProvenance;
	/**
	 * The contained allocation and own writable data cell this base and key name.
	 * Undefined whenever an accessor, Proxy, hole/prototype walk, shape change, or
	 * foreign reference could be involved. Array length is read-only here.
	 */
	ownCell(
		base: CoreValueId,
		key: CoreAccessKey,
		mode: CoreAccessMode,
	): { readonly layout: CoreAllocationLayout; readonly cell: CoreOwnCell } | undefined;
	/**
	 * Whether `CanBeHeldWeakly` rejects this value, so no `WeakRef` or
	 * `FinalizationRegistry` can observe when it stops being reachable. A transform
	 * that changes how long a value is referenced — dropping a store, or keeping an
	 * older one alive because a later store was dropped — is only unobservable for
	 * such a value.
	 */
	cannotBeHeldWeakly(value: CoreValueId): boolean;
}

export interface CoreContainedAggregateOwnSlot {
	readonly slot: number;
	readonly origins: ReadonlyArray<CoreInstructionId>;
}

/** Local, exact value provenance through compiler-proven private aggregates. */
export interface CoreContainedAggregateProvenance {
	/** Physical slot shared by every possible stable shaped-object receiver. */
	ownSlot(instruction: CoreInstruction): CoreContainedAggregateOwnSlot | undefined;
	/** Numeric dense reads and pops whose non-empty premise is control-flow exact. */
	isInBounds(instruction: CoreInstructionId): boolean;
}

/**
 * Additional non-escaping uses proved by a consumer before asking provenance to
 * close an allocation. The exemption is deliberately operand-granular: proving
 * that a builtin does not retain its receiver must not silently exempt the same
 * value when it is also passed as an argument.
 *
 * This is an assumption boundary, not an analysis result. A caller must prove
 * the complete semantics of every listed operand independently; provenance then
 * continues to reject every unlisted use of the allocation.
 */
export interface CoreProvenanceOptions {
	readonly assumedNonEscapingOperands?: ReadonlyMap<
		CoreInstructionId,
		ReadonlySet<number>
	>;
	/** Canonical roots already owned by a shared analysis manager. */
	readonly canonicalRoots?: ReadonlyMap<CoreValueId, CoreValueId>;
}

function numberArray(value: unknown): ReadonlyArray<number> | undefined {
	return Array.isArray(value) &&
		value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry))
		? value
		: undefined;
}

function allocationLayout(
	instruction: CoreInstruction,
): CoreAllocationLayout | undefined {
	const descriptor = coreOpcodeRegistry.require(instruction.opcode);
	const allocation = descriptor.allocation;
	if (allocation === undefined || instruction.outputs.length !== 1) return undefined;
	if (allocation.kind === "indexed") {
		const length = instruction.attributes[allocation.lengthAttribute];
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > 0xffff_ffff
		) {
			return undefined;
		}
		return {
			kind: "indexed",
			instruction: instruction.id,
			result: instruction.outputs[0]!,
			length,
			elements: new Map(),
		};
	}
	const keys = numberArray(instruction.attributes[allocation.keysAttribute]);
	if (keys === undefined || new Set(keys).size !== keys.length) return undefined;
	const initialValues = instruction.inputs.slice(allocation.firstValueOperand);
	// A literal whose declared keys and initial values disagree is not a layout
	// this analysis can describe, so it stays an opaque allocation.
	if (initialValues.length !== keys.length) return undefined;
	return {
		kind: "named-slots",
		instruction: instruction.id,
		result: instruction.outputs[0]!,
		keys,
		initialValues,
	};
}

/**
 * The one place where an operand's role depends on an attribute rather than on
 * its position: strict equality and `typeof` inspect a reference without handing
 * it to user code. Everything else comes from the registry's declarations.
 */
function observesOperands(instruction: CoreInstruction): boolean {
	if (coreOpcodeRegistry.require(instruction.opcode).observesOperands === true) {
		return true;
	}
	const operator = instruction.attributes.operator;
	if (instruction.opcode === "binary") return operator === "===" || operator === "!==";
	if (instruction.opcode === "unary") return operator === "typeof";
	return false;
}

interface BaseUse {
	readonly operand: number;
	readonly key: CoreAccessKey | undefined;
	/** A read of an existing own slot cannot run a getter; a shape edit can. */
	readonly kind:
		| "slot-read"
		| "slot-write"
		| "slot-define"
		| "shape-edit"
		| "prototype-read";
	readonly establishesOwnDataSlot: boolean;
}

function accessKey(
	access: CoreOpcodeAccess,
	instruction: CoreInstruction,
): CoreAccessKey | undefined {
	if (access.keyAttribute !== undefined) {
		const index = instruction.attributes[access.keyAttribute];
		return typeof index === "number" && Number.isSafeInteger(index)
			? { kind: "string-constant", index }
			: undefined;
	}
	if (access.keyOperand !== undefined) {
		const value = instruction.inputs[access.keyOperand];
		return value === undefined ? undefined : { kind: "operand", value };
	}
	return undefined;
}

function sameAccessKey(
	left: CoreAccessKey | undefined,
	right: CoreAccessKey | undefined,
): boolean {
	return (
		left?.kind === right?.kind &&
		(left?.kind === "string-constant"
			? left.index ===
				(right as Extract<CoreAccessKey, { kind: "string-constant" }>).index
			: left?.kind === "operand"
				? left.value === (right as Extract<CoreAccessKey, { kind: "operand" }>).value
				: true)
	);
}

/**
 * Operands that address an object rather than pass it on, derived from the
 * registry's declared accesses. An access without a declared base operand leaves
 * that operand a capture, which is the conservative default.
 */
function baseUses(instruction: CoreInstruction): ReadonlyArray<BaseUse> {
	const declared = coreOpcodeRegistry.require(instruction.opcode).accesses;
	if (declared === undefined) return [];
	const uses: Array<BaseUse> = [];
	for (const access of declared) {
		if (access.baseOperand === undefined) continue;
		if (!CORE_MEMORY_FAMILY_DOMAINS[access.family].includes("object-property")) continue;
		uses.push({
			operand: access.baseOperand,
			key: accessKey(access, instruction),
			establishesOwnDataSlot: access.establishesOwnDataSlot === true,
			kind:
				access.family === "prototype"
					? access.mode === "read"
						? "prototype-read"
						: "shape-edit"
					: access.family === "shape"
						? "shape-edit"
						: access.mode === "read"
							? "slot-read"
							: "slot-write",
		});
	}
	return uses;
}

/**
 * Collapse every access role for an operand conservatively. Most property
 * opcodes have one access, but shape-changing operations deliberately declare
 * both their slot and shape effects. Their safety must not depend on declaration
 * order: any disagreement is a shape edit, which forces the allocation to
 * escape this analysis.
 */
function baseUsesByOperand(instruction: CoreInstruction): ReadonlyMap<number, BaseUse> {
	const result = new Map<number, BaseUse>();
	for (const use of baseUses(instruction)) {
		const previous = result.get(use.operand);
		if (previous === undefined) {
			result.set(use.operand, use);
			continue;
		}
		if (
			previous.kind === use.kind &&
			sameAccessKey(previous.key, use.key) &&
			previous.establishesOwnDataSlot === use.establishesOwnDataSlot
		) {
			continue;
		}
		if (
			sameAccessKey(previous.key, use.key) &&
			((previous.kind === "slot-write" &&
				previous.establishesOwnDataSlot &&
				use.kind === "shape-edit") ||
				(use.kind === "slot-write" &&
					use.establishesOwnDataSlot &&
					previous.kind === "shape-edit") ||
				(previous.kind === "slot-define" && use.kind === "shape-edit") ||
				(previous.kind === "slot-define" &&
					use.kind === "slot-write" &&
					use.establishesOwnDataSlot))
		) {
			result.set(use.operand, {
				operand: use.operand,
				key: use.key,
				kind: "slot-define",
				establishesOwnDataSlot: true,
			});
			continue;
		}
		result.set(use.operand, {
			operand: use.operand,
			key: undefined,
			kind: "shape-edit",
			establishesOwnDataSlot: false,
		});
	}
	return result;
}

const canonicalStringIndexCache = new WeakMap<
	ReadonlyArray<ReadonlyArray<number>>,
	ReadonlyMap<number, number>
>();

function canonicalStringIndices(
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): ReadonlyMap<number, number> {
	const cached = canonicalStringIndexCache.get(stringConstants);
	if (cached !== undefined) return cached;
	const canonical = new Map<string, number>();
	const byIndex = new Map<number, number>();
	for (const [index, units] of stringConstants.entries()) {
		const key = units.join(",");
		let first = canonical.get(key);
		if (first === undefined) {
			first = index;
			canonical.set(key, index);
		}
		byIndex.set(index, first);
	}
	canonicalStringIndexCache.set(stringConstants, byIndex);
	return byIndex;
}

function canonicalArrayIndex(
	units: ReadonlyArray<number> | undefined,
): number | undefined {
	if (units === undefined || units.length === 0) return undefined;
	if (units.length > 1 && units[0] === 0x30) return undefined;
	let value = 0;
	for (const unit of units) {
		if (unit < 0x30 || unit > 0x39) return undefined;
		value = value * 10 + (unit - 0x30);
		if (value > 0xffff_ffff) return undefined;
	}
	return value === 0xffff_ffff ? undefined : value;
}

export function coreOwnCellsEqual(left: CoreOwnCell, right: CoreOwnCell): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "element"
			? left.index === (right as Extract<CoreOwnCell, { kind: "element" }>).index
			: left.key === (right as Extract<CoreOwnCell, { kind: "object-slot" }>).key)
	);
}

/**
 * Canonical own-cell identity for a string-constant key, shared with any analysis
 * that must agree on which cell a key spelling names. Two spellings of the same
 * text canonicalize to one index, and an array-index spelling becomes an element
 * cell, so `o.0`, `o["0"]`, and `o[0]` cannot be mistaken for three cells.
 */
export function coreOwnCellResolver(
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): (index: number) => CoreOwnCell | undefined {
	const canonicalStrings = canonicalStringIndices(stringConstants);
	return (index: number): CoreOwnCell | undefined => {
		const canonicalIndex =
			canonicalStrings.get(index) ??
			(Number.isSafeInteger(index) && index >= 0 ? index : undefined);
		if (canonicalIndex === undefined) return undefined;
		const element = canonicalArrayIndex(stringConstants[canonicalIndex]);
		return element === undefined
			? { kind: "object-slot", key: canonicalIndex }
			: { kind: "element", index: element };
	};
}

export function coreProvenance(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	options: CoreProvenanceOptions = {},
): CoreProvenance {
	const roots = options.canonicalRoots ?? coreCanonicalValueRoots(fn, cfg);
	const canonical = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const definitions = new Map<CoreValueId, CoreInstruction>();
	const callClaims = new Map<CoreInstructionId, CoreCallValueSummaryClaim>();
	const positions = new Map<
		CoreInstructionId,
		{ readonly block: CoreBlockId; readonly index: number }
	>();
	for (const block of fn.blocks) {
		for (const [index, instruction] of block.instructions.entries()) {
			positions.set(instruction.id, { block: block.id, index });
			for (const output of instruction.outputs) definitions.set(output, instruction);
			const claim = coreCallSummaryClaimFromAttribute(
				instruction.attributes[CORE_CALL_SUMMARY_ATTRIBUTE],
			);
			if (instruction.opcode === "call" && claim !== undefined) {
				callClaims.set(instruction.id, claim);
			}
		}
	}
	const cellForString = coreOwnCellResolver(stringConstants);
	const normalized = new Map<CoreValueId, CoreOwnCell | null>();
	const cellForValue = (value: CoreValueId): CoreOwnCell | undefined => {
		const root = canonical(value);
		const cached = normalized.get(root);
		if (cached !== undefined) return cached === null ? undefined : cached;
		const seen = new Set<CoreValueId>();
		let current = root;
		while (!seen.has(current)) {
			seen.add(current);
			const definition = definitions.get(current);
			if (definition === undefined) break;
			if (definition.opcode === "move" && definition.inputs.length === 1) {
				current = canonical(definition.inputs[0]!);
				continue;
			}
			if (definition.opcode === "createString") {
				const index = definition.attributes.stringIndex;
				const cell = typeof index === "number" ? cellForString(index) : undefined;
				normalized.set(root, cell ?? null);
				return cell;
			}
			if (definition.opcode === "createNumber" || definition.opcode === "createF64") {
				const number = definition.attributes.value;
				const index =
					typeof number === "number" &&
					Number.isInteger(number) &&
					number >= 0 &&
					number <= 0xffff_fffe
						? Object.is(number, -0)
							? 0
							: number
						: undefined;
				const cell =
					index === undefined ? undefined : ({ kind: "element", index } as const);
				normalized.set(root, cell ?? null);
				return cell;
			}
			break;
		}
		normalized.set(root, null);
		return undefined;
	};
	const cellForKey = (key: CoreAccessKey): CoreOwnCell | undefined =>
		key.kind === "string-constant" ? cellForString(key.index) : cellForValue(key.value);
	const layouts: Array<CoreAllocationLayout> = [];
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const layout = allocationLayout(instruction);
			if (layout !== undefined) layouts.push(layout);
		}
	}
	// Two allocations that collapse to one root make the root ambiguous, so
	// neither can be described exactly any more.
	const layoutByRoot = new Map<CoreValueId, CoreAllocationLayout>();
	const ambiguousRoots = new Set<CoreValueId>();
	for (const layout of layouts) {
		const root = canonical(layout.result);
		if (layoutByRoot.has(root)) ambiguousRoots.add(root);
		layoutByRoot.set(root, layout);
	}
	const returnedInput = (
		instruction: CoreInstruction,
		claim: CoreCallValueSummaryClaim,
	): CoreValueId | undefined => {
		if (claim.returnProvenance.kind === "receiver") return instruction.inputs[1];
		return claim.returnProvenance.kind === "parameter"
			? instruction.inputs[claim.returnProvenance.index + 2]
			: undefined;
	};
	const summaryAliases = new Map<CoreValueId, CoreValueId>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const claim = callClaims.get(instruction.id);
			const output = instruction.outputs[0];
			const input = claim === undefined ? undefined : returnedInput(instruction, claim);
			if (output !== undefined && input !== undefined) {
				summaryAliases.set(canonical(output), canonical(input));
			}
		}
	}
	const layoutOf = (value: CoreValueId): CoreAllocationLayout | undefined => {
		let root = canonical(value);
		const seen = new Set<CoreValueId>();
		while (!seen.has(root)) {
			seen.add(root);
			const alias = summaryAliases.get(root);
			if (alias === undefined) break;
			root = canonical(alias);
		}
		return ambiguousRoots.has(root) ? undefined : layoutByRoot.get(root);
	};
	const invalidIndexedLayouts = new Set<CoreInstructionId>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const access of coreOpcodeRegistry.require(instruction.opcode).accesses ??
				[]) {
				if (
					access.establishesOwnDataSlot !== true ||
					access.baseOperand === undefined ||
					access.valueOperand === undefined
				) {
					continue;
				}
				const base = instruction.inputs[access.baseOperand];
				const value = instruction.inputs[access.valueOperand];
				const key = accessKey(access, instruction);
				const layout = base === undefined ? undefined : layoutOf(base);
				const cell = key === undefined ? undefined : cellForKey(key);
				if (
					layout?.kind !== "indexed" ||
					cell?.kind !== "element" ||
					cell.index >= layout.length ||
					value === undefined
				) {
					continue;
				}
				const elements = layout.elements as Map<number, CoreArrayElementLayout>;
				if (elements.has(cell.index)) {
					invalidIndexedLayouts.add(layout.instruction);
					continue;
				}
				elements.set(cell.index, {
					index: cell.index,
					value,
					definition: instruction.id,
				});
			}
		}
	}
	const structurallyEscaped = new Set<CoreInstructionId>(
		layouts
			.filter(
				({ instruction, result }) =>
					ambiguousRoots.has(canonical(result)) || invalidIndexedLayouts.has(instruction),
			)
			.map(({ instruction }) => instruction),
	);
	const instructionDominates = (
		dominator: CoreInstructionId,
		instruction: CoreInstructionId,
	): boolean => {
		const left = positions.get(dominator);
		const right = positions.get(instruction);
		if (left === undefined || right === undefined) return false;
		return left.block === right.block
			? left.index <= right.index
			: cfg.instructionDominatesBlock(left.block, right.block);
	};
	const cellBelongsToLayout = (
		layout: CoreAllocationLayout,
		cell: CoreOwnCell,
		mode: CoreAccessMode,
		instruction: CoreInstructionId,
	): boolean => {
		if (layout.kind === "named-slots") {
			return cell.kind === "object-slot" && layout.keys.includes(cell.key);
		}
		if (cell.kind === "object-slot") {
			const units = stringConstants[cell.key];
			const isLength =
				units?.length === 6 &&
				units.every(
					(unit, index) => unit === [0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68][index],
				);
			return isLength && mode === "read";
		}
		const element = layout.elements.get(cell.index);
		return element !== undefined && instructionDominates(element.definition, instruction);
	};

	const escapedFor = (viewOptions: CoreProvenanceOptions): Set<CoreInstructionId> => {
		const escaped = new Set(structurallyEscaped);
		if (layouts.length > 0) {
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					const observes = observesOperands(instruction);
					const bases = baseUsesByOperand(instruction);
					for (const [operand, input] of instruction.inputs.entries()) {
						const layout = layoutOf(input);
						if (layout === undefined) continue;
						if (observes) continue;
						if (
							viewOptions.assumedNonEscapingOperands
								?.get(instruction.id)
								?.has(operand) === true
						) {
							continue;
						}
						const claim = callClaims.get(instruction.id);
						const callEscape =
							claim === undefined
								? undefined
								: operand === 1
									? claim.receiverEscape
									: operand >= 2
										? claim.argumentEscape[operand - 2]
										: undefined;
						const callContainment =
							claim === undefined
								? undefined
								: operand === 1
									? claim.receiverContainment
									: operand >= 2
										? claim.argumentContainment[operand - 2]
										: undefined;
						if (
							callContainment === "preserved" &&
							(callEscape === "none" ||
								(callEscape === "returned" &&
									instruction.outputs[0] !== undefined &&
									layoutOf(instruction.outputs[0]) === layout))
						) {
							continue;
						}
						const use = bases.get(operand);
						if (use === undefined) {
							escaped.add(layout.instruction);
							continue;
						}
						switch (use.kind) {
							case "prototype-read":
								// An ordinary object's [[GetPrototypeOf]] runs no trap and hands the
								// receiver to nothing.
								break;
							case "slot-read":
							case "slot-write": {
								// A hole or a key outside the layout reaches the prototype chain, where
								// an accessor would receive this object, or edits its shape. A present
								// array element is usable only after its own-data define dominates.
								const cell = use.key === undefined ? undefined : cellForKey(use.key);
								if (
									cell === undefined ||
									!cellBelongsToLayout(
										layout,
										cell,
										use.kind === "slot-read" ? "read" : "write",
										instruction.id,
									)
								) {
									escaped.add(layout.instruction);
								}
								break;
							}
							case "slot-define": {
								const cell = use.key === undefined ? undefined : cellForKey(use.key);
								if (
									cell === undefined ||
									!cellBelongsToLayout(layout, cell, "write", instruction.id) ||
									(layout.kind === "indexed" &&
										(cell.kind !== "element" ||
											layout.elements.get(cell.index)?.definition !== instruction.id))
								) {
									escaped.add(layout.instruction);
								}
								break;
							}
							case "shape-edit":
								escaped.add(layout.instruction);
								break;
						}
					}
				}
				const terminator = block.terminator;
				const escapeValue = (value: CoreValueId): void => {
					const layout = layoutOf(value);
					if (layout !== undefined) escaped.add(layout.instruction);
				};
				if (terminator.kind === "return" || terminator.kind === "throw") {
					escapeValue(terminator.value);
				}
				// A branch, switch, or guard condition tests the reference without
				// retaining it, so only the values crossing an edge matter here.
				for (const edge of coreTerminatorEdges(terminator)) {
					const target = fn.blocks[edge.block];
					if (target === undefined) continue;
					for (const [index, argument] of edge.arguments.entries()) {
						const layout = layoutOf(argument);
						if (layout === undefined) continue;
						const parameter = target.parameters[index];
						// A join that does not collapse to this allocation loses its identity:
						// later uses of the parameter are no longer attributable, so the
						// allocation must be treated as reachable from anywhere.
						if (
							parameter === undefined ||
							canonical(parameter.value) !== canonical(layout.result)
						) {
							escaped.add(layout.instruction);
						}
					}
				}
				for (const argument of block.handler?.arguments ?? []) escapeValue(argument);
			}
		}
		return escaped;
	};

	const representations = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);

	const view = (viewOptions: CoreProvenanceOptions): CoreProvenance => {
		const escaped = escapedFor(viewOptions);
		return {
			layouts,
			allocationOf: layoutOf,
			withAssumedNonEscapingOperands: (assumptions) =>
				view({ assumedNonEscapingOperands: assumptions }),
			cannotBeHeldWeakly: (value) => {
				const root = canonical(value);
				// An unboxed class is a number or a boolean whatever produced it, which
				// covers loop-carried parameters the producer test cannot see through.
				const representation = representations.get(root);
				if (
					representation === "f64" ||
					representation === "i32" ||
					representation === "boolean"
				) {
					return true;
				}
				const producer = definitions.get(root);
				const callClaim =
					producer === undefined ? undefined : callClaims.get(producer.id);
				if (callClaim?.returnProvenance.kind === "primitive") return true;
				// A block parameter merging several proven primitives stays unproven; the
				// conjunction needs its own fixed point, which no consumer needs yet.
				return (
					producer !== undefined &&
					coreOpcodeRegistry.require(producer.opcode).resultCannotBeHeldWeakly === true
				);
			},
			escape: (allocation) => (escaped.has(allocation) ? "escaped" : "contained"),
			ownCell: (base, key, mode) => {
				const layout = layoutOf(base);
				if (layout === undefined || escaped.has(layout.instruction)) return undefined;
				const cell = cellForKey(key);
				if (cell === undefined) return undefined;
				if (layout.kind === "named-slots") {
					return cell.kind === "object-slot" && layout.keys.includes(cell.key)
						? { layout, cell }
						: undefined;
				}
				if (cell.kind === "element") {
					return layout.elements.has(cell.index) ? { layout, cell } : undefined;
				}
				const units = stringConstants[cell.key];
				const isLength =
					units?.length === 6 &&
					units.every(
						(unit, index) => unit === [0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68][index],
					);
				return isLength && mode === "read" ? { layout, cell } : undefined;
			},
		};
	};
	return view(options);
}

const CORE_CONTAINED_AGGREGATE_ORIGIN_CAP = 4;

function coreValueLimit(fn: CoreFunction): number {
	let limit = 0;
	for (const { id } of fn.values) limit = Math.max(limit, id + 1);
	return limit;
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function intersectSets<T>(sets: ReadonlyArray<ReadonlySet<T>>): Set<T> {
	if (sets.length === 0) return new Set();
	const result = new Set(sets[0]);
	for (const candidate of [...result]) {
		if (sets.slice(1).some((set) => !set.has(candidate))) result.delete(candidate);
	}
	return result;
}

/**
 * Recover exact shaped-object values through a private dense Array.
 *
 * This is deliberately local. An exact Array certificate already proves that
 * every operation on the carrier is visible in this activation; this analysis
 * adds the transitive ownership fact that storing a fresh shaped object in that
 * carrier does not publish it. A bounded value graph then joins every initial
 * element and exact push into one abstract element cell. Only an element read or
 * pop proven non-empty is allowed to expose that closed cell.
 *
 * Shape stability is checked independently after the value solve. Each possible
 * origin may be inspected, moved, stored in the same private carrier, or accessed
 * through one of its initial writable data slots. Any other use rejects that
 * origin. Thus a successful query is stronger than a shape candidate: the value
 * must be an ordinary shaped object, every possible origin has the requested key
 * at the same physical slot, and no operation can transition its shape.
 */
export function coreContainedAggregateProvenance(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): CoreContainedAggregateProvenance {
	const exactElementInstructions = fn.blocks.flatMap(({ instructions }) =>
		instructions.filter(
			(instruction) =>
				instruction.opcode === "loadProperty" &&
				instruction.attributes[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE] === true,
		),
	);
	if (exactElementInstructions.length === 0) {
		return {
			ownSlot: () => undefined,
			isInBounds: () => false,
		};
	}
	const exactCarrierInstructions = fn.blocks.flatMap(({ instructions }) =>
		instructions.filter(
			(instruction) =>
				(instruction.opcode === "callBuiltin" &&
					(instruction.attributes.operation === "Array.prototype.push" ||
						instruction.attributes.operation === "Array.prototype.pop")) ||
				exactElementInstructions.includes(instruction),
		),
	);
	const ordinary = coreProvenance(fn, cfg, stringConstants);
	const assumptions = new Map<CoreInstructionId, Set<number>>();
	const assume = (instruction: CoreInstructionId, operand: number): void => {
		const existing = assumptions.get(instruction);
		if (existing === undefined) assumptions.set(instruction, new Set([operand]));
		else existing.add(operand);
	};
	const referencedArrays = new Map<CoreInstructionId, CoreIndexedAllocationLayout>();
	for (const instruction of exactCarrierInstructions) {
		const exactCall =
			instruction.opcode === "callBuiltin" &&
			(instruction.attributes.operation === "Array.prototype.push" ||
				instruction.attributes.operation === "Array.prototype.pop");
		const exactElement =
			instruction.opcode === "loadProperty" &&
			instruction.attributes[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE] === true;
		if (!exactCall && !exactElement) continue;
		const receiver = instruction.inputs[0];
		const layout = receiver === undefined ? undefined : ordinary.allocationOf(receiver);
		if (layout?.kind !== "indexed") continue;
		referencedArrays.set(layout.instruction, layout);
		assume(instruction.id, 0);
	}
	if (referencedArrays.size === 0) {
		return {
			ownSlot: () => undefined,
			isInBounds: () => false,
		};
	}
	const conditional = ordinary.withAssumedNonEscapingOperands(assumptions);
	const arrays = new Map(
		[...referencedArrays].filter(
			([allocation]) => conditional.escape(allocation) === "contained",
		),
	);
	if (arrays.size === 0) {
		return {
			ownSlot: () => undefined,
			isInBounds: () => false,
		};
	}
	const arrayOf = (value: CoreValueId): CoreIndexedAllocationLayout | undefined => {
		const layout = conditional.allocationOf(value);
		return layout?.kind === "indexed" ? arrays.get(layout.instruction) : undefined;
	};

	const definitions = new Map<CoreValueId, CoreInstruction>();
	const instructionBlocks = new Map<CoreInstructionId, CoreBlockId>();
	const instructionPositions = new Map<CoreInstructionId, number>();
	for (const block of fn.blocks) {
		for (const [position, instruction] of block.instructions.entries()) {
			instructionBlocks.set(instruction.id, block.id);
			instructionPositions.set(instruction.id, position);
			for (const output of instruction.outputs) definitions.set(output, instruction);
		}
	}
	const roots = coreCanonicalValueRoots(fn, cfg);
	const canonical = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
	const definition = (value: CoreValueId): CoreInstruction | undefined =>
		definitions.get(canonical(value));
	const exactNumber = (value: CoreValueId): number | undefined => {
		const producer = definition(value);
		if (producer?.opcode !== "createNumber" && producer?.opcode !== "createF64") {
			return undefined;
		}
		const number = producer.attributes.value;
		return typeof number === "number" ? number : undefined;
	};
	const exactLengthArray = (
		value: CoreValueId,
	): CoreIndexedAllocationLayout | undefined => {
		const producer = definition(value);
		if (
			producer?.opcode !== "loadPropertyStatic" ||
			producer.attributes[CORE_FRESH_ARRAY_LENGTH_ATTRIBUTE] !== true ||
			producer.inputs.length !== 1
		) {
			return undefined;
		}
		return arrayOf(producer.inputs[0]!);
	};
	const conditionNonemptyArray = (
		condition: CoreValueId,
	): CoreIndexedAllocationLayout | undefined => {
		const comparison = definition(condition);
		if (comparison?.opcode !== "binary" || comparison.inputs.length !== 2) {
			return undefined;
		}
		const leftArray = exactLengthArray(comparison.inputs[0]!);
		const rightArray = exactLengthArray(comparison.inputs[1]!);
		const leftNumber = exactNumber(comparison.inputs[0]!);
		const rightNumber = exactNumber(comparison.inputs[1]!);
		return comparison.attributes.operator === ">" &&
			leftArray !== undefined &&
			rightNumber === 0
			? leftArray
			: comparison.attributes.operator === "<" &&
				  leftNumber === 0 &&
				  rightArray !== undefined
				? rightArray
				: undefined;
	};
	const lastElementArray = (
		instruction: CoreInstruction,
	): CoreIndexedAllocationLayout | undefined => {
		if (
			instruction.opcode !== "loadProperty" ||
			instruction.attributes[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE] !== true ||
			instruction.inputs.length !== 2
		) {
			return undefined;
		}
		const array = arrayOf(instruction.inputs[0]!);
		const key = definition(instruction.inputs[1]!);
		if (
			array === undefined ||
			key?.opcode !== "binary" ||
			key.attributes.operator !== "-" ||
			key.inputs.length !== 2 ||
			exactNumber(key.inputs[1]!) !== 1 ||
			exactLengthArray(key.inputs[0]!)?.instruction !== array.instruction
		) {
			return undefined;
		}
		const length = definition(key.inputs[0]!);
		return length !== undefined &&
			instructionBlocks.get(length.id) === instructionBlocks.get(instruction.id) &&
			(instructionPositions.get(length.id) ?? Number.POSITIVE_INFINITY) <
				(instructionPositions.get(instruction.id) ?? -1)
			? array
			: undefined;
	};

	interface StateEdge {
		readonly from: CoreBlockId;
		readonly to: CoreBlockId;
		readonly exceptional: boolean;
		readonly refine?: CoreInstructionId;
		state: Set<CoreInstructionId>;
	}
	const allArrays = new Set(arrays.keys());
	const incoming = new Map<CoreBlockId, Array<StateEdge>>();
	const outgoing = new Map<CoreBlockId, Array<StateEdge>>();
	const addStateEdge = (edge: StateEdge): void => {
		const to = incoming.get(edge.to);
		if (to === undefined) incoming.set(edge.to, [edge]);
		else to.push(edge);
		const from = outgoing.get(edge.from);
		if (from === undefined) outgoing.set(edge.from, [edge]);
		else from.push(edge);
	};
	for (const block of fn.blocks) {
		const addOrdinary = (to: CoreBlockId, refine?: CoreIndexedAllocationLayout): void =>
			addStateEdge({
				from: block.id,
				to,
				exceptional: false,
				...(refine === undefined ? {} : { refine: refine.instruction }),
				state: new Set(allArrays),
			});
		const terminator = block.terminator;
		switch (terminator.kind) {
			case "jump":
				addOrdinary(terminator.edge.block);
				break;
			case "branch":
				addOrdinary(
					terminator.consequent.block,
					conditionNonemptyArray(terminator.condition),
				);
				addOrdinary(terminator.alternate.block);
				break;
			case "guard":
				addOrdinary(terminator.success.block);
				addOrdinary(terminator.fallback.block);
				break;
			case "switch":
				for (const entry of terminator.cases) addOrdinary(entry.edge.block);
				addOrdinary(terminator.default.block);
				break;
		}
		if (block.handler !== undefined) {
			addStateEdge({
				from: block.id,
				to: block.handler.block,
				exceptional: true,
				state: new Set(),
			});
		}
	}
	const transferNonempty = (
		block: CoreFunction["blocks"][number],
		initial: ReadonlySet<CoreInstructionId>,
	): Set<CoreInstructionId> => {
		const state = new Set(initial);
		for (const instruction of block.instructions) {
			const allocation = arrays.get(instruction.id);
			if (allocation !== undefined && allocation.length > 0) state.add(instruction.id);
			if (instruction.opcode !== "callBuiltin") continue;
			const receiver = instruction.inputs[0];
			const array = receiver === undefined ? undefined : arrayOf(receiver);
			if (array === undefined) continue;
			if (instruction.attributes.operation === "Array.prototype.push") {
				if (instruction.inputs.length > 1) state.add(array.instruction);
			} else if (instruction.attributes.operation === "Array.prototype.pop") {
				state.delete(array.instruction);
			}
		}
		return state;
	};
	const entryStates = new Map<CoreBlockId, Set<CoreInstructionId>>();
	for (const block of fn.blocks) {
		entryStates.set(block.id, block.id === fn.entry ? new Set() : new Set(allArrays));
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const blockId of cfg.reversePostorder) {
			const block = fn.blocks[blockId]!;
			const nextEntry =
				blockId === fn.entry
					? new Set<CoreInstructionId>()
					: intersectSets((incoming.get(blockId) ?? []).map(({ state }) => state));
			if (!setsEqual(entryStates.get(blockId)!, nextEntry)) {
				entryStates.set(blockId, nextEntry);
				changed = true;
			}
			const exit = transferNonempty(block, nextEntry);
			for (const edge of outgoing.get(blockId) ?? []) {
				const next = edge.exceptional ? new Set<CoreInstructionId>() : new Set(exit);
				if (edge.refine !== undefined) next.add(edge.refine);
				if (!setsEqual(edge.state, next)) {
					edge.state = next;
					changed = true;
				}
			}
		}
	}
	const inBounds = new Set<CoreInstructionId>();
	for (const blockId of cfg.reversePostorder) {
		const block = fn.blocks[blockId]!;
		const state = new Set(entryStates.get(blockId));
		for (const instruction of block.instructions) {
			const allocation = arrays.get(instruction.id);
			if (allocation !== undefined && allocation.length > 0) state.add(instruction.id);
			const lastArray = lastElementArray(instruction);
			if (lastArray !== undefined && state.has(lastArray.instruction)) {
				inBounds.add(instruction.id);
			}
			if (instruction.opcode !== "callBuiltin") continue;
			const receiver = instruction.inputs[0];
			const array = receiver === undefined ? undefined : arrayOf(receiver);
			if (array === undefined) continue;
			if (instruction.attributes.operation === "Array.prototype.push") {
				if (instruction.inputs.length > 1) state.add(array.instruction);
			} else if (instruction.attributes.operation === "Array.prototype.pop") {
				if (state.has(array.instruction)) inBounds.add(instruction.id);
				state.delete(array.instruction);
			}
		}
	}

	const valueLimit = coreValueLimit(fn);
	const origins = ordinary.layouts.filter(
		(layout): layout is CoreNamedAllocationLayout =>
			layout.kind === "named-slots" &&
			definitions.get(layout.result)?.opcode === "createObjectShaped",
	);
	const originIndex = new Map(
		origins.map((layout, index) => [layout.instruction, index] as const),
	);
	const cellNodes = new Map<CoreInstructionId, number>();
	for (const allocation of arrays.keys())
		cellNodes.set(allocation, valueLimit + cellNodes.size);
	const nodeCount = valueLimit + cellNodes.size;
	const dependents = new Map<number, Array<number>>();
	const addEdge = (source: number, destination: number): void => {
		const existing = dependents.get(source);
		if (existing === undefined) dependents.set(source, [destination]);
		else existing.push(destination);
	};
	const originSeeds: Array<readonly [number, number]> = [];
	const opaqueSeeds: Array<number> = [];
	for (const layout of origins) {
		const index = originIndex.get(layout.instruction)!;
		originSeeds.push([layout.result, index]);
	}
	const allowedStorageOperands = new Set<string>();
	for (const layout of arrays.values()) {
		const cell = cellNodes.get(layout.instruction)!;
		for (const element of layout.elements.values()) {
			addEdge(element.value, cell);
			const defining = fn.blocks
				.flatMap(({ instructions }) => instructions)
				.find(({ id }) => id === element.definition);
			if (defining === undefined) continue;
			for (const access of coreOpcodeRegistry.require(defining.opcode).accesses ?? []) {
				if (
					access.establishesOwnDataSlot === true &&
					access.valueOperand !== undefined &&
					defining.inputs[access.valueOperand] === element.value
				) {
					allowedStorageOperands.add(`${defining.id}:${access.valueOperand}`);
				}
			}
		}
		if (layout.elements.size !== layout.length) opaqueSeeds.push(cell);
	}
	for (const block of fn.blocks) {
		const incomingEdges = cfg.predecessors[block.id] ?? [];
		for (const [index, parameter] of block.parameters.entries()) {
			let ordinarySource = false;
			let excludedSource = parameter.role === "exception";
			for (const edge of incomingEdges) {
				if (edge.kind !== "ordinary") {
					excludedSource = true;
					continue;
				}
				const argument = edge.arguments[index];
				if (argument === undefined) {
					excludedSource = true;
					continue;
				}
				ordinarySource = true;
				addEdge(argument, parameter.value);
			}
			if (block.id === fn.entry || !ordinarySource || excludedSource) {
				opaqueSeeds.push(parameter.value);
			}
		}
		for (const instruction of block.instructions) {
			const output = instruction.outputs[0];
			if (instruction.opcode === "createObjectShaped" && output !== undefined) {
				for (const extra of instruction.outputs.slice(1)) opaqueSeeds.push(extra);
				continue;
			}
			if (
				instruction.opcode === "move" &&
				instruction.inputs.length === 1 &&
				instruction.outputs.length === 1
			) {
				addEdge(instruction.inputs[0]!, instruction.outputs[0]!);
				continue;
			}
			const exactElement =
				instruction.opcode === "loadProperty" &&
				instruction.attributes[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE] === true;
			const exactPop =
				instruction.opcode === "callBuiltin" &&
				instruction.attributes.operation === "Array.prototype.pop";
			if ((exactElement || exactPop) && output !== undefined) {
				const receiver = instruction.inputs[0];
				const array = receiver === undefined ? undefined : arrayOf(receiver);
				const cell = array === undefined ? undefined : cellNodes.get(array.instruction);
				if (cell !== undefined && inBounds.has(instruction.id)) {
					addEdge(cell, output);
					for (const extra of instruction.outputs.slice(1)) opaqueSeeds.push(extra);
					continue;
				}
			}
			if (
				instruction.opcode === "callBuiltin" &&
				instruction.attributes.operation === "Array.prototype.push"
			) {
				const receiver = instruction.inputs[0];
				const array = receiver === undefined ? undefined : arrayOf(receiver);
				const cell = array === undefined ? undefined : cellNodes.get(array.instruction);
				if (cell !== undefined) {
					for (let operand = 1; operand < instruction.inputs.length; operand++) {
						addEdge(instruction.inputs[operand]!, cell);
						allowedStorageOperands.add(`${instruction.id}:${operand}`);
					}
				}
			}
			for (const value of instruction.outputs) opaqueSeeds.push(value);
		}
	}
	const candidatesByNode = new Array<Array<number> | undefined>(nodeCount).fill(
		undefined,
	);
	const opaqueByNode = new Uint8Array(nodeCount);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	let queueIndex = 0;
	const enqueue = (node: number): void => {
		if (queued[node] !== 0) return;
		queued[node] = 1;
		queue.push(node);
	};
	const raiseOpaque = (node: number): void => {
		if (opaqueByNode[node] !== 0) return;
		opaqueByNode[node] = 1;
		enqueue(node);
	};
	const raiseOrigin = (node: number, origin: number): void => {
		let candidates = candidatesByNode[node];
		if (candidates?.includes(origin) === true) return;
		if (candidates === undefined) {
			candidates = [];
			candidatesByNode[node] = candidates;
		}
		if (candidates.length === CORE_CONTAINED_AGGREGATE_ORIGIN_CAP) {
			raiseOpaque(node);
			return;
		}
		candidates.push(origin);
		candidates.sort((left, right) => left - right);
		enqueue(node);
	};
	for (const [node, origin] of originSeeds) raiseOrigin(node, origin);
	for (const node of opaqueSeeds) raiseOpaque(node);
	while (queueIndex < queue.length) {
		const source = queue[queueIndex++]!;
		queued[source] = 0;
		for (const destination of dependents.get(source) ?? []) {
			for (const origin of candidatesByNode[source] ?? []) {
				raiseOrigin(destination, origin);
			}
			if (opaqueByNode[source] !== 0) raiseOpaque(destination);
		}
	}

	const cellForString = coreOwnCellResolver(stringConstants);
	const slotFor = (
		layout: CoreNamedAllocationLayout,
		stringIndex: number,
	): number | undefined => {
		const requested = cellForString(stringIndex);
		if (requested?.kind !== "object-slot") return undefined;
		const slot = layout.keys.findIndex((key) => {
			const candidate = cellForString(key);
			return candidate?.kind === "object-slot" && candidate.key === requested.key;
		});
		return slot < 0 ? undefined : slot;
	};
	const unstable = new Uint8Array(origins.length);
	const markUnstable = (value: CoreValueId): void => {
		for (const origin of candidatesByNode[value] ?? []) unstable[origin] = 1;
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const observed = observesOperands(instruction);
			for (const [operand, input] of instruction.inputs.entries()) {
				const candidates = candidatesByNode[input] ?? [];
				if (candidates.length === 0) continue;
				const stringIndex = instruction.attributes.stringIndex;
				const stableReceiver =
					operand === 0 &&
					(instruction.opcode === "loadPropertyStatic" ||
						instruction.opcode === "storePropertyStatic") &&
					typeof stringIndex === "number" &&
					candidates.every(
						(origin) => slotFor(origins[origin]!, stringIndex) !== undefined,
					);
				if (
					observed ||
					(instruction.opcode === "move" && operand === 0) ||
					allowedStorageOperands.has(`${instruction.id}:${operand}`) ||
					stableReceiver
				) {
					continue;
				}
				for (const origin of candidates) unstable[origin] = 1;
			}
		}
		if (block.terminator.kind === "return" || block.terminator.kind === "throw") {
			markUnstable(block.terminator.value);
		}
	}

	return {
		ownSlot: (
			instruction: CoreInstruction,
		): CoreContainedAggregateOwnSlot | undefined => {
			if (
				(instruction.opcode !== "loadPropertyStatic" &&
					instruction.opcode !== "storePropertyStatic") ||
				instruction.inputs.length !==
					(instruction.opcode === "loadPropertyStatic" ? 1 : 2)
			) {
				return undefined;
			}
			const stringIndex = instruction.attributes.stringIndex;
			if (typeof stringIndex !== "number") return undefined;
			const receiver = instruction.inputs[0]!;
			const candidateIds = candidatesByNode[receiver] ?? [];
			if (
				candidateIds.length === 0 ||
				opaqueByNode[receiver] !== 0 ||
				candidateIds.some((origin) => unstable[origin] !== 0)
			) {
				return undefined;
			}
			let slot: number | undefined;
			for (const origin of candidateIds) {
				const candidate = slotFor(origins[origin]!, stringIndex);
				if (candidate === undefined) return undefined;
				if (slot === undefined) slot = candidate;
				else if (slot !== candidate) return undefined;
			}
			return slot === undefined
				? undefined
				: Object.freeze({
						slot,
						origins: Object.freeze(
							candidateIds.map((origin) => origins[origin]!.instruction),
						),
					});
		},
		isInBounds: (instruction) => inBounds.has(instruction),
	};
}
