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
import { CORE_MEMORY_FAMILY_DOMAINS } from "./core-ir.ts";
import type {
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";

/**
 * Fact kind a pass attaches when it narrows a property access to a contained own
 * data slot. The verifier re-proves exactly this kind, so a future guarded or
 * epoch refinement of the same opcode is not held to a containment it never
 * claimed.
 */
export const CORE_OWN_DATA_SLOT_FACT = "own-data-slot";

/**
 * A fresh ordinary object whose own data slots Core knows exactly. Every key is
 * an own writable data property from the moment the object exists, so an access
 * naming one of them consults no prototype, accessor, or Proxy trap.
 */
export interface CoreAllocationLayout {
	readonly instruction: CoreInstructionId;
	readonly result: CoreValueId;
	/** Own data keys as string-constant indices, in slot order. */
	readonly keys: ReadonlyArray<number>;
	/** Initial value of each key, in the same order. */
	readonly initialValues: ReadonlyArray<CoreValueId>;
}

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
	 * The contained allocation whose own writable data slot this base and key
	 * name. Undefined whenever an accessor, Proxy, prototype walk, shape change,
	 * or foreign reference could be involved.
	 */
	ownDataSlot(base: CoreValueId, key: number): CoreAllocationLayout | undefined;
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
	const keys = numberArray(instruction.attributes[allocation.keysAttribute]);
	if (keys === undefined || new Set(keys).size !== keys.length) return undefined;
	const initialValues = instruction.inputs.slice(allocation.firstValueOperand);
	// A literal whose declared keys and initial values disagree is not a layout
	// this analysis can describe, so it stays an opaque allocation.
	if (initialValues.length !== keys.length) return undefined;
	return {
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
	/** Own-slot key when the access names one exactly. */
	readonly key: number | undefined;
	/** A read of an existing own slot cannot run a getter; a shape edit can. */
	readonly kind: "slot-read" | "slot-write" | "shape-edit" | "prototype-read";
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
		const key =
			access.keyAttribute === undefined
				? undefined
				: typeof instruction.attributes[access.keyAttribute] === "number"
					? (instruction.attributes[access.keyAttribute] as number)
					: undefined;
		uses.push({
			operand: access.baseOperand,
			key,
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
		if (previous.kind === use.kind && previous.key === use.key) continue;
		result.set(use.operand, {
			operand: use.operand,
			key: undefined,
			kind: "shape-edit",
		});
	}
	return result;
}

export function coreProvenance(fn: CoreFunction, cfg: CoreControlFlow): CoreProvenance {
	const roots = coreCanonicalValueRoots(fn, cfg);
	const canonical = (value: CoreValueId): CoreValueId => roots.get(value) ?? value;
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
	const layoutOf = (value: CoreValueId): CoreAllocationLayout | undefined => {
		const root = canonical(value);
		return ambiguousRoots.has(root) ? undefined : layoutByRoot.get(root);
	};
	const escaped = new Set<CoreInstructionId>(
		layouts
			.filter(({ result }) => ambiguousRoots.has(canonical(result)))
			.map(({ instruction }) => instruction),
	);

	if (layouts.length > 0) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const observes = observesOperands(instruction);
				const bases = baseUsesByOperand(instruction);
				for (const [operand, input] of instruction.inputs.entries()) {
					const layout = layoutOf(input);
					if (layout === undefined) continue;
					if (observes) continue;
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
						case "slot-write":
							// A key outside the layout reaches the prototype chain, where an
							// accessor would receive this object, or adds a property and changes
							// the shape this analysis relies on.
							if (use.key === undefined || !layout.keys.includes(use.key)) {
								escaped.add(layout.instruction);
							}
							break;
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

	const definitions = new Map<CoreValueId, CoreInstruction>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const output of instruction.outputs) definitions.set(output, instruction);
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
			// A block parameter merging several proven primitives stays unproven; the
			// conjunction needs its own fixed point, which no consumer needs yet.
			return (
				producer !== undefined &&
				coreOpcodeRegistry.require(producer.opcode).resultCannotBeHeldWeakly === true
			);
		},
		escape: (allocation) => (escaped.has(allocation) ? "escaped" : "contained"),
		ownDataSlot: (base, key) => {
			const layout = layoutOf(base);
			if (layout === undefined || escaped.has(layout.instruction)) return undefined;
			return layout.keys.includes(key) ? layout : undefined;
		},
	};
}
