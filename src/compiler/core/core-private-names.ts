import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface PrivateNameWriter {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly value: CoreValueId;
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
	}
	return undefined;
}

export class CoreModulePrivateNameIndex {
	readonly #program: CoreProgram;
	readonly #evaluators = new Map<number, number>();
	readonly #writers = new Map<number, Map<CoreFunctionId, Array<PrivateNameWriter>>>();
	readonly #functionSlots = new Map<CoreFunctionId, Set<number>>();
	readonly #valid = new Map<number, boolean>();
	readonly #controls = new Map<CoreFunctionId, CoreControlFlow>();
	#revision = -1;
	#generation = -1;

	constructor(program: CoreProgram, context: CoreCompilationContext) {
		this.#program = program;
		for (const { slot, evaluator } of context.data.modulePrivateNames ?? []) {
			if (this.#evaluators.has(slot))
				throw new Error(`Duplicate module-private slot ${slot}`);
			this.#evaluators.set(slot, evaluator);
		}
	}

	#refresh(): void {
		if (this.#generation !== this.#program.generation) {
			this.#writers.clear();
			this.#functionSlots.clear();
			this.#valid.clear();
			this.#controls.clear();
			this.#revision = -1;
			this.#generation = this.#program.generation;
		}
		if (this.#revision === this.#program.programFlowRevision) return;
		const dirty = new Set<CoreFunctionId>();
		if (this.#revision < 0) {
			for (const id of this.#program.functionIds()) dirty.add(id);
		} else {
			for (
				let revision = this.#revision;
				revision < this.#program.programFlowRevision;
				revision++
			)
				dirty.add(this.#program.programFlowFunctionAt(revision));
		}
		for (const id of dirty) {
			this.#controls.delete(id);
			for (const slot of this.#functionSlots.get(id) ?? []) {
				this.#writers.get(slot)?.delete(id);
				this.#valid.delete(slot);
			}
			const slots = new Set<number>();
			this.#functionSlots.set(id, slots);
			if (!this.#program.hasFunction(id)) continue;
			const fn = this.#program.function(id);
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				if (fn.instructionOpcodeName(instruction) !== "storeGlobal") continue;
				const slot = fn.instructionAttributes(instruction).index;
				if (typeof slot !== "number" || !this.#evaluators.has(slot)) continue;
				const writers =
					this.#writers.get(slot) ?? new Map<CoreFunctionId, Array<PrivateNameWriter>>();
				const writes = writers.get(id) ?? [];
				writes.push({
					function: id,
					instruction,
					value: fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
				});
				writers.set(id, writes);
				this.#writers.set(slot, writers);
				this.#valid.delete(slot);
				slots.add(slot);
			}
		}
		this.#revision = this.#program.programFlowRevision;
	}

	validSlot(slot: number): boolean {
		if (!this.#evaluators.has(slot)) return false;
		this.#refresh();
		const cached = this.#valid.get(slot);
		if (cached !== undefined) return cached;
		const writes = [...(this.#writers.get(slot)?.values() ?? [])].flat();
		let valid = false;
		if (writes.length === 1 && writes[0]!.function === this.#evaluators.get(slot)) {
			const write = writes[0]!,
				fn = this.#program.function(write.function);
			const mint = definition(fn, write.value);
			if (mint !== undefined && fn.instructionOpcodeName(mint) === "createPrivateName") {
				let cfg = this.#controls.get(fn.id);
				if (cfg === undefined)
					this.#controls.set(fn.id, (cfg = buildCoreControlFlow(this.#program, fn.id)));
				const block = fn.instructionBlock(write.instruction);
				valid =
					cfg.reachable.has(block) &&
					!cfg.loops.some((loop) => loop.blocks.has(block)) &&
					!cfg.irreducibleCycles.some((cycle) => cycle.blocks.has(block));
			}
		}
		this.#valid.set(slot, valid);
		return valid;
	}

	/** Equality of keys is usable only after the original private read succeeds. */
	keySlot(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
		const load = definition(fn, value);
		if (load === undefined || fn.instructionOpcodeName(load) !== "loadGlobal")
			return undefined;
		const slot = fn.instructionAttributes(load).index;
		if (typeof slot !== "number" || !this.validSlot(slot)) return undefined;
		if (fn.id === this.#evaluators.get(slot)) {
			const write = this.#writers.get(slot)?.get(fn.id)?.[0];
			if (write === undefined) return undefined;
			const writerBlock = fn.instructionBlock(write.instruction),
				readerBlock = fn.instructionBlock(load);
			if (writerBlock === readerBlock) {
				for (
					let next = fn.instructionNext(write.instruction);
					next !== undefined;
					next = fn.instructionNext(next)
				)
					if (next === load) return slot;
				return undefined;
			}
			if (!this.#controls.get(fn.id)?.instructionDominatesBlock(writerBlock, readerBlock))
				return undefined;
		}
		return slot;
	}
}

const indices = new WeakMap<
	CoreProgram,
	WeakMap<CoreCompilationContext, CoreModulePrivateNameIndex>
>();

export function coreModulePrivateNames(
	program: CoreProgram,
	context: CoreCompilationContext,
): CoreModulePrivateNameIndex {
	let contexts = indices.get(program);
	if (contexts === undefined) indices.set(program, (contexts = new WeakMap()));
	let index = contexts.get(context);
	if (index === undefined)
		contexts.set(context, (index = new CoreModulePrivateNameIndex(program, context)));
	return index;
}
