import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface GlobalWrite {
	readonly slot: number;
	readonly instruction: CoreInstructionId;
	readonly value: CoreValueId;
	readonly empty: boolean;
}

interface GlobalWriteScan {
	readonly bodyVersion: number;
	readonly writes: ReadonlyArray<GlobalWrite>;
}

const scans = new WeakMap<CoreFunctionStore, GlobalWriteScan>();

function globalWrites(fn: CoreFunctionStore): ReadonlyArray<GlobalWrite> {
	const bodyVersion = fn.hasActiveEditor ? undefined : fn.version("body");
	const cached = scans.get(fn);
	if (bodyVersion !== undefined && cached?.bodyVersion === bodyVersion)
		return cached.writes;
	const empty = (value: CoreValueId): boolean => {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return false;
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(definition);
		return (
			opcode === "createEmpty" ||
			(opcode === "move" &&
				fn.kernel.instructionOperandCount(definition) === 1 &&
				empty(fn.kernel.operandAt(fn.kernel.instructionOperandStart(definition))))
		);
	};
	const writes: Array<GlobalWrite> = [];
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "storeGlobal" ||
			fn.kernel.instructionOperandCount(instruction) !== 1
		)
			continue;
		const slot = fn.instructionAttributes(instruction).index;
		if (typeof slot !== "number") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		writes.push({ slot, instruction, value, empty: empty(value) });
	}
	if (bodyVersion !== undefined) scans.set(fn, { bodyVersion, writes });
	return writes;
}

export interface CoreModuleGlobalWrites {
	readonly stores: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly value: CoreValueId;
	}>;
	readonly resets: ReadonlyArray<CoreInstructionId>;
}

/** Private lexical cells whose non-empty writers all belong to this evaluator. */
export function coreEvaluatorGlobalWrites(
	program: CoreProgram,
	context: CoreCompilationContext,
	fn: CoreFunctionStore,
): ReadonlyMap<number, CoreModuleGlobalWrites> {
	const cells = new Map<
		number,
		{ stores: Array<GlobalWrite>; resets: Array<CoreInstructionId> }
	>();
	if (
		context.facts.world.eval !== "disabled" ||
		context.facts.closure.sourceClosure.kind !== "known" ||
		context.data.moduleLinks !== undefined
	)
		return cells;
	for (const { slot, evaluator } of context.data.moduleLexicalSlots ?? [])
		if (evaluator === fn.id) cells.set(slot, { stores: [], resets: [] });
	if (cells.size === 0) return cells;
	for (const functionId of program.functionIds()) {
		for (const write of globalWrites(program.function(functionId))) {
			const cell = cells.get(write.slot);
			if (cell === undefined) continue;
			if (functionId !== fn.id) {
				// Other functions may instantiate the TDZ, but cannot assign the binding.
				if (!write.empty) cells.delete(write.slot);
			} else if (write.empty) cell.resets.push(write.instruction);
			else cell.stores.push(write);
		}
	}
	return cells;
}

/** A dominating value store must follow every explicit reset in the evaluator. */
export function coreModuleGlobalLoadInitialized(
	fn: CoreFunctionStore,
	control: CoreControlFlow,
	cell: CoreModuleGlobalWrites,
	load: CoreInstructionId,
): boolean {
	const precedes = (first: CoreInstructionId, second: CoreInstructionId): boolean => {
		const firstBlock = fn.instructionBlock(first);
		const secondBlock = fn.instructionBlock(second);
		if (firstBlock !== secondBlock)
			return control.instructionDominatesBlock(firstBlock, secondBlock);
		for (const instruction of fn.instructionIds(firstBlock)) {
			if (instruction === second) return false;
			if (instruction === first) return true;
		}
		return false;
	};
	return cell.stores.some(
		(store) =>
			precedes(store.instruction, load) &&
			cell.resets.every((reset) => precedes(reset, store.instruction)),
	);
}
