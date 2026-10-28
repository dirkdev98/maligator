import { coreClosedGlobalSlotMembership } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { coreNumericTypedArrayKind } from "./core-heap-brands.ts";
import type { CoreExactHeapBrand } from "./core-heap-brands.ts";
import { analyzeCoreValueClasses } from "./core-ir-value-classes.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

function definitionOpcode(fn: CoreFunctionStore, value: CoreValueId): string | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "move") return opcode;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

/**
 * Whether each source-immutable global slot holds an Array or one numeric
 * TypedArray kind once it is initialized, when every store into the slot writes
 * an object of that class.
 * Such an object keeps its class for life, and a read of the slot before its
 * store throws instead of producing a value, so every read that yields a value
 * yields that object. Direct eval could declare or write globals invisibly.
 */
export function analyzeCoreGlobalSlotBrands(
	program: CoreProgram,
	context: CoreCompilationContext,
): ReadonlyMap<number, CoreExactHeapBrand> {
	const slots = coreClosedGlobalSlotMembership(context);
	if (slots.size === 0 || context.facts.world.eval === "runtime") return new Map();
	const brands = new Map<number, CoreExactHeapBrand | null>();
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		let classes: ReturnType<typeof analyzeCoreValueClasses> | undefined;
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "storeGlobal" ||
				fn.kernel.instructionOperandCount(instruction) === 0
			)
				continue;
			const slot = fn.instructionAttributes(instruction).index;
			if (typeof slot !== "number" || !slots.has(slot)) continue;
			const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
			// The uninitialized marker is not a value: reading it throws.
			if (definitionOpcode(fn, value) === "createEmpty") continue;
			classes ??= analyzeCoreValueClasses(program, id, context);
			const exact = classes.exactHeapBrand(value);
			// Collection brands imply a contained receiver, which other holders of the object break.
			const brand =
				exact === "Array" || coreNumericTypedArrayKind(exact) !== undefined
					? exact!
					: null;
			brands.set(slot, brands.has(slot) && brands.get(slot) !== brand ? null : brand);
		}
	}
	const known = new Map<number, CoreExactHeapBrand>();
	for (const [slot, brand] of brands) if (brand !== null) known.set(slot, brand);
	return known;
}
