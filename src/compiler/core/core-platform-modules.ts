import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

function input(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	return index < fn.kernel.instructionOperandCount(instruction)
		? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index)
		: undefined;
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId | undefined,
): CoreInstructionId | undefined {
	if (value === undefined || fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	return fn.instructionKind(instruction) === "operation" ? instruction : undefined;
}

function eagerInitializer(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): number | undefined {
	if (fn.instructionOpcodeName(instruction) !== "call") return undefined;
	const callee = definition(fn, input(fn, instruction, 0));
	const initializer = definition(fn, input(fn, instruction, 2));
	if (
		callee === undefined ||
		initializer === undefined ||
		fn.instructionOpcodeName(callee) !== "loadIntrinsic" ||
		fn.instructionAttributes(callee).intrinsic !== "__evaluateModuleSync" ||
		fn.instructionOpcodeName(initializer) !== "createFunction"
	)
		return undefined;
	const target = fn.instructionAttributes(initializer).functionIndex;
	return typeof target === "number" ? target : undefined;
}

/** Pure module evaluation and hoisted declarations are removable only while their cells are unobserved. */
export function pruneUnusedPlatformModuleInitializers(
	compilation: ConstructedCoreCompilation,
): void {
	const candidates = compilation.context.data.pureModuleInitializers ?? [];
	if (candidates.length === 0) return;
	const { program } = compilation;
	const initializers = new Set(candidates.map((entry) => entry.functionIndex));
	const slotOwners = new Map(
		candidates.flatMap((entry) =>
			entry.bindingSlots.map((slot) => [slot, entry.functionIndex] as const),
		),
	);
	const needed = new Set<number>();
	const initializerParents = new Map<number, Set<number>>();
	for (const owner of initializers) {
		const fn = program.function(coreFunctionId(owner));
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const target = eagerInitializer(fn, instruction);
			if (target === undefined || !initializers.has(target)) continue;
			const parents = initializerParents.get(target) ?? new Set<number>();
			parents.add(owner);
			initializerParents.set(target, parents);
		}
	}
	const unusedModuleDeclaration = (
		fn: CoreFunctionStore,
		instruction: CoreInstructionId,
	): boolean => {
		if (fn.instructionOpcodeName(instruction) !== "createFunction") return false;
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		if (fn.kernel.valueHandlerUseCount(value) !== 0 || fn.valueUseCount(value) === 0)
			return false;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			const store = fn.kernel.useInstruction(use);
			if (
				fn.instructionKind(store) !== "operation" ||
				fn.instructionOpcodeName(store) !== "storeGlobal"
			)
				return false;
			const slot = fn.instructionAttributes(store).index;
			const owner = typeof slot === "number" ? slotOwners.get(slot) : undefined;
			if (owner === undefined || needed.has(owner)) return false;
		}
		return true;
	};
	const visited = new Set<CoreFunctionId>();
	const pending = [
		coreFunctionId(0),
		...compilation.context.data.cjsModuleFunctionIndices.map(coreFunctionId),
	];
	const demandInitializer = (owner: number) => {
		if (needed.has(owner)) return;
		needed.add(owner);
		pending.push(coreFunctionId(owner));
		// Re-export-only modules can be the sole evaluation path to a live dependency.
		for (const parent of initializerParents.get(owner) ?? []) demandInitializer(parent);
	};
	const demand = (slot: number) => {
		const owner = slotOwners.get(slot);
		if (owner !== undefined) demandInitializer(owner);
	};
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (visited.has(id) || !program.hasFunction(id)) continue;
		visited.add(id);
		const fn = program.function(id);
		for (const instruction of [...buildCoreControlFlow(program, id).reachable].flatMap(
			(block) => [...fn.bodyInstructionIds(block)],
		)) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const attributes = fn.instructionAttributes(instruction);
			if (eagerInitializer(fn, instruction) !== undefined) continue;
			if (unusedModuleDeclaration(fn, instruction)) continue;
			if (opcode === "loadGlobal" && typeof attributes.index === "number")
				demand(attributes.index);
			if (opcode === "createModuleNamespace" && Array.isArray(attributes.exports)) {
				for (const entry of attributes.exports as ReadonlyArray<unknown>) {
					if (
						entry !== null &&
						typeof entry === "object" &&
						!Array.isArray(entry) &&
						"slot" in entry &&
						typeof entry.slot === "number"
					)
						demand(entry.slot);
				}
			}
			if (
				typeof attributes.functionIndex === "number" &&
				attributes.functionIndex >= 0 &&
				!initializers.has(attributes.functionIndex)
			)
				pending.push(coreFunctionId(attributes.functionIndex));
		}
	}
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		const editor = CoreEditor.open(program, id);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			if (fn.instructionOpcodeName(instruction) === "storeGlobal") {
				const slot = fn.instructionAttributes(instruction).index;
				const owner = typeof slot === "number" ? slotOwners.get(slot) : undefined;
				if (owner !== undefined && !needed.has(owner))
					editor.removeInstruction(instruction);
				continue;
			}
			const target = eagerInitializer(fn, instruction);
			if (target === undefined || !initializers.has(target) || needed.has(target))
				continue;
			const initializer = definition(fn, input(fn, instruction, 2))!;
			editor.removeInstruction(instruction);
			const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(initializer));
			if (fn.valueUseCount(result) === 0) editor.removeInstruction(initializer);
		}
		editor.commit();
	}
}
