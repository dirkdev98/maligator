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

export function coreProvenance(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): CoreProvenance {
	const roots = coreCanonicalValueRoots(fn, cfg);
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
	const canonicalStrings = canonicalStringIndices(stringConstants);
	const cellForString = (index: number): CoreOwnCell | undefined => {
		const canonicalIndex =
			canonicalStrings.get(index) ??
			(Number.isSafeInteger(index) && index >= 0 ? index : undefined);
		if (canonicalIndex === undefined) return undefined;
		const units = stringConstants[canonicalIndex];
		const element = canonicalArrayIndex(units);
		return element === undefined
			? { kind: "object-slot", key: canonicalIndex }
			: { kind: "element", index: element };
	};
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
	const escaped = new Set<CoreInstructionId>(
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

	if (layouts.length > 0) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const observes = observesOperands(instruction);
				const bases = baseUsesByOperand(instruction);
				for (const [operand, input] of instruction.inputs.entries()) {
					const layout = layoutOf(input);
					if (layout === undefined) continue;
					if (observes) continue;
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

	const representations = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);

	return {
		layouts,
		allocationOf: layoutOf,
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
			const callClaim = producer === undefined ? undefined : callClaims.get(producer.id);
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
}
