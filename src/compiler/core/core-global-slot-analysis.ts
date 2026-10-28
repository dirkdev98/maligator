import { coreClosedGlobalSlotMembership } from "./core-compilation.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
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
 * Stable brands of initialized values in closed immutable slots. Reading an
 * uninitialized slot throws; direct eval would invalidate the store inventory.
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
			const brand = classes.exactHeapBrand(value) ?? null;
			brands.set(slot, brands.has(slot) && brands.get(slot) !== brand ? null : brand);
		}
	}
	const known = new Map<number, CoreExactHeapBrand>();
	for (const [slot, brand] of brands) if (brand !== null) known.set(slot, brand);
	return known;
}
