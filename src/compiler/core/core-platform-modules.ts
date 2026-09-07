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

/** Public module evaluation is removable only while none of its export cells are observed. */
export function pruneUnusedPlatformModuleInitializers(
	compilation: ConstructedCoreCompilation,
): void {
	const candidates = compilation.context.data.pureModuleInitializers ?? [];
	if (candidates.length === 0) return;
	const { program } = compilation;
	const initializers = new Set(candidates.map((entry) => entry.functionIndex));
	const slotOwners = new Map(
		candidates.flatMap((entry) =>
			entry.exportSlots.map((slot) => [slot, entry.functionIndex] as const),
		),
	);
	const needed = new Set<number>();
	const visited = new Set<CoreFunctionId>();
	const pending = [
		coreFunctionId(0),
		...compilation.context.data.cjsModuleFunctionIndices.map(coreFunctionId),
	];
	const demand = (slot: number) => {
		const owner = slotOwners.get(slot);
		if (owner === undefined || needed.has(owner)) return;
		needed.add(owner);
		pending.push(coreFunctionId(owner));
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
