import type { CoreCompilationContext } from "../core/core-compilation.ts";
import { buildCoreControlFlow } from "../core/core-ir-control-flow.ts";
import type { CoreControlFlow } from "../core/core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "../core/core-ir.ts";
import type {
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
	SealedCoreProgram,
} from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";

/** One function's share of the closures whose function objects are created only when observed. */
export interface CoreDirectClosurePlan {
	readonly creations: ReadonlySet<CoreInstructionId>;
	/** Exact calls of such a closure, keyed to the function whose activation created it. */
	readonly calls: ReadonlyMap<CoreInstructionId, CoreFunctionId>;
	/** Binding loads whose value escapes, so they create the object the first time they run. */
	readonly materializations: ReadonlyMap<
		CoreInstructionId,
		{ readonly target: CoreFunctionId; readonly owner: CoreFunctionId }
	>;
}

// The marker would be mistaken for an uninitialized binding.
const EMPTY_OBSERVING_OPCODES: ReadonlySet<string> = new Set(["throwIfTdz", "isEmpty"]);

const UNOBSERVED_CALLEE_EXCLUSIONS: ReadonlySet<string> = new Set([
	"loadCallee",
	"createArgumentsObject",
]);

const SCOPE_CHANGING_OPCODES: ReadonlySet<string> = new Set([
	"envPush",
	"envCopy",
	"envPop",
	"withEnter",
	"withExit",
]);

function cellKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

function onlyOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	value: CoreValueId,
): number {
	const start = fn.kernel.instructionOperandStart(instruction);
	let found = -1;
	for (
		let operand = 0;
		operand < fn.kernel.instructionOperandCount(instruction);
		operand++
	) {
		if (fn.kernel.operandAt(start + operand) !== value) continue;
		if (found >= 0) return -1;
		found = operand;
	}
	return found;
}

function readsOwnObject(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds())
		if (
			fn.instructionKind(instruction) === "operation" &&
			UNOBSERVED_CALLEE_EXCLUSIONS.has(fn.instructionOpcodeName(instruction))
		)
			return true;
	return false;
}

function result(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreValueId | undefined {
	return fn.kernel.instructionResultCount(instruction) === 1
		? fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction))
		: undefined;
}

/**
 * Find nested functions whose object is observed only through their binding cell.
 * Their creating activation can then skip the allocation: native callers
 * rebuild the creation environment from the owner scope they already reach, and a
 * binding read whose value escapes creates the object from that scope and stores
 * it back, so every later read sees the same function. The cell keeps a marker
 * until then; a creation that would need its own capture vector still
 * materializes the object and its callers fall back to it.
 */
export function planCoreDirectClosures(
	program: SealedCoreProgram,
	context: CoreCompilationContext,
	live: ReadonlyArray<CoreFunctionId>,
	exactCalls: ReadonlyMap<CoreFunctionId, ReadonlyMap<CoreInstructionId, CoreFunctionId>>,
): ReadonlyMap<CoreFunctionId, CoreDirectClosurePlan> {
	const plans = new Map<CoreFunctionId, CoreDirectClosurePlan>();
	if (context.facts.closure.sourceClosure.kind !== "known") return plans;
	const creations = new Map<
		CoreFunctionId,
		Array<{ readonly owner: CoreFunctionId; readonly instruction: CoreInstructionId }>
	>();
	const stores = new Map<string, number>();
	const loads = new Map<
		string,
		Array<{ readonly fn: CoreFunctionStore; readonly instruction: CoreInstructionId }>
	>();
	const aliased = new Set<string>();
	const scopeChanging = new Set<CoreFunctionId>();
	for (const functionId of live) {
		const fn = program.function(functionId);
		for (const index of fn.metadata.mappedArgumentSlots)
			aliased.add(cellKey(functionId, index));
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const attributes = fn.instructionAttributes(instruction);
			if (opcode.startsWith("with")) return plans;
			if (SCOPE_CHANGING_OPCODES.has(opcode)) scopeChanging.add(functionId);
			if (opcode === "createFunction") {
				const target = coreFunctionId(attributes.functionIndex as number);
				const sites = creations.get(target) ?? [];
				sites.push({ owner: functionId, instruction });
				creations.set(target, sites);
			} else if (opcode === "storeCaptured" || opcode === "loadCaptured") {
				const key = cellKey(
					attributes.functionIndex as number,
					attributes.index as number,
				);
				if (opcode === "storeCaptured") stores.set(key, (stores.get(key) ?? 0) + 1);
				else {
					const sites = loads.get(key) ?? [];
					sites.push({ fn, instruction });
					loads.set(key, sites);
				}
			} else if (opcode === "createPrivateNames") {
				for (const index of attributes.capturedIndices as ReadonlyArray<number>)
					aliased.add(cellKey(attributes.functionIndex as number, index));
			}
		}
	}
	const plan = (functionId: CoreFunctionId) => {
		let entry = plans.get(functionId) as
			| {
					creations: Set<CoreInstructionId>;
					calls: Map<CoreInstructionId, CoreFunctionId>;
					materializations: Map<
						CoreInstructionId,
						{ readonly target: CoreFunctionId; readonly owner: CoreFunctionId }
					>;
			  }
			| undefined;
		if (entry === undefined) {
			entry = { creations: new Set(), calls: new Map(), materializations: new Map() };
			plans.set(functionId, entry);
		}
		return entry;
	};
	const ownerFlows = new Map<CoreFunctionId, CoreControlFlow>();
	// The owner's own loads read the marker only after the creation has stored it.
	const storeDominates = (
		owner: CoreFunctionId,
		store: CoreInstructionId | undefined,
		load: CoreInstructionId,
	): boolean => {
		if (store === undefined) return false;
		const fn = program.function(owner);
		const storeBlock = fn.instructionBlock(store);
		const loadBlock = fn.instructionBlock(load);
		if (storeBlock === loadBlock) {
			for (const instruction of fn.instructionIds(loadBlock)) {
				if (instruction === store) return true;
				if (instruction === load) return false;
			}
			return false;
		}
		let flow = ownerFlows.get(owner);
		if (flow === undefined) {
			flow = buildCoreControlFlow(program, owner, { exceptions: true });
			ownerFlows.set(owner, flow);
		}
		return flow.instructionDominatesBlock(storeBlock, loadBlock);
	};
	const exactCallee = (
		fn: CoreFunctionStore,
		instruction: CoreInstructionId,
		value: CoreValueId,
		target: CoreFunctionId,
	): boolean => {
		if (
			fn.instructionKind(instruction) !== "operation" ||
			fn.instructionOpcodeName(instruction) !== "call" ||
			exactCalls.get(fn.id)?.get(instruction) !== target
		)
			return false;
		const callee = fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer
			?.calleeOperand;
		return callee !== undefined && onlyOperand(fn, instruction, value) === callee;
	};
	for (const [target, sites] of creations)
		for (const { owner, instruction: creation } of sites) {
			const callee = program.function(target);
			const creator = program.function(owner);
			if (
				callee.isGenerator ||
				callee.isAsync ||
				callee.metadata.isClassConstructor ||
				callee.metadata.isDerivedConstructor ||
				creator.isGenerator ||
				creator.isAsync ||
				scopeChanging.has(owner) ||
				readsOwnObject(callee)
			)
				continue;
			const value = result(creator, creation);
			if (value === undefined || creator.kernel.valueHandlerUseCount(value) !== 0)
				continue;
			const ownerCalls: Array<CoreInstructionId> = [];
			let cell: string | undefined;
			let cellStore: CoreInstructionId | undefined;
			let eligible = true;
			for (
				let use = creator.kernel.valueFirstUse(value);
				use >= 0;
				use = creator.kernel.useNext(use)
			) {
				const instruction = creator.kernel.useInstruction(use);
				if (exactCallee(creator, instruction, value, target)) {
					ownerCalls.push(instruction);
					continue;
				}
				if (
					cell === undefined &&
					creator.instructionKind(instruction) === "operation" &&
					creator.instructionOpcodeName(instruction) === "storeCaptured" &&
					creator.instructionAttributes(instruction).functionIndex === owner &&
					onlyOperand(creator, instruction, value) === 0
				) {
					cell = cellKey(
						owner,
						creator.instructionAttributes(instruction).index as number,
					);
					cellStore = coreInstructionId(instruction);
					continue;
				}
				eligible = false;
				break;
			}
			// A shared binding cell would hold one creator's marker for every other creator's callers.
			if (!eligible || (cell !== undefined && sites.length !== 1)) continue;
			const cellCalls: Array<{
				readonly fn: CoreFunctionStore;
				readonly instruction: CoreInstructionId;
			}> = [];
			const materializations: Array<{
				readonly fn: CoreFunctionStore;
				readonly instruction: CoreInstructionId;
			}> = [];
			if (cell !== undefined) {
				if (aliased.has(cell) || stores.get(cell) !== 1) continue;
				for (const load of loads.get(cell) ?? []) {
					const loaded = result(load.fn, load.instruction);
					// Resumable bodies render calls without the owner-scope environment.
					if (
						(load.fn.id === owner &&
							!storeDominates(owner, cellStore, load.instruction)) ||
						load.fn.isGenerator ||
						load.fn.isAsync ||
						loaded === undefined ||
						load.fn.kernel.valueHandlerUseCount(loaded) !== 0
					) {
						eligible = false;
						break;
					}
					let escapes = false;
					for (
						let use = load.fn.kernel.valueFirstUse(loaded);
						use >= 0;
						use = load.fn.kernel.useNext(use)
					) {
						const instruction = load.fn.kernel.useInstruction(use);
						if (exactCallee(load.fn, instruction, loaded, target)) {
							cellCalls.push({ fn: load.fn, instruction });
							continue;
						}
						if (
							load.fn.instructionKind(instruction) === "operation" &&
							EMPTY_OBSERVING_OPCODES.has(load.fn.instructionOpcodeName(instruction))
						) {
							eligible = false;
							break;
						}
						escapes = true;
					}
					if (!eligible) break;
					if (escapes) materializations.push(load);
				}
				if (!eligible) continue;
			}
			plan(owner).creations.add(creation);
			for (const instruction of ownerCalls) plan(owner).calls.set(instruction, owner);
			for (const call of cellCalls) plan(call.fn.id).calls.set(call.instruction, owner);
			for (const load of materializations)
				plan(load.fn.id).materializations.set(load.instruction, { target, owner });
		}
	return plans;
}
