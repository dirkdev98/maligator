import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

interface Creation {
	readonly caller: CoreFunctionId;
	readonly instruction: CoreInstructionId;
}

interface Candidate {
	readonly owner: CoreFunctionId;
	readonly closure?: CoreFunctionId;
	readonly allocation: CoreInstructionId;
	readonly store: CoreInstructionId;
	readonly slot: number;
	readonly reads: Array<CoreInstructionId>;
	readonly observers: Set<CoreFunctionId>;
	valid: boolean;
}

const MAX_CLOSURES = 16;
const MAX_BRANCH_BLOCKS = 64;
const MAX_OBSERVERS = 128;

function eligibleOwner(fn: CoreFunctionStore): boolean {
	return !(
		fn.isAsync ||
		fn.isGenerator ||
		fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor ||
		fn.metadata.mappedArguments ||
		fn.handlerBlockCount !== 0 ||
		[...fn.factIds()].length !== 0
	);
}

function candidate(fn: CoreFunctionStore): Candidate | undefined {
	if (!eligibleOwner(fn)) return undefined;
	for (const instruction of fn.bodyInstructionIds(fn.entry)) {
		const start = fn.instructionAttributes(instruction).startIndex;
		if (
			fn.instructionOpcodeName(instruction) !== "createRestArguments" ||
			typeof start !== "number" ||
			!Number.isSafeInteger(start) ||
			start < 0
		)
			continue;
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		if (fn.valueUseCount(value) !== 1 || fn.kernel.valueHandlerUseCount(value) !== 0)
			continue;
		let use = fn.kernel.valueFirstUse(value);
		while (use >= 0 && fn.kernel.useLive(use) === 0) use = fn.kernel.useNext(use);
		if (use < 0) continue;
		const store = coreInstructionId(fn.kernel.useInstruction(use));
		if (
			fn.instructionKind(store) !== "operation" ||
			fn.instructionOpcodeName(store) !== "storeCaptured" ||
			fn.instructionBlock(store) !== fn.entry
		)
			continue;
		const { functionIndex, index } = fn.instructionAttributes(store);
		if (functionIndex !== fn.id || typeof index !== "number") continue;
		return {
			owner: fn.id,
			allocation: instruction,
			store,
			slot: index,
			reads: [],
			observers: new Set(),
			valid: true,
		};
	}
	return undefined;
}

function closureCandidates(fn: CoreFunctionStore): Array<Candidate> {
	if (!eligibleOwner(fn) || !fn.metadata.strict || fn.metadata.capturedCount === 0)
		return [];
	const candidates: Array<Candidate> = [];
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		if (fn.instructionOpcodeName(instruction) !== "createFunction") continue;
		const target = fn.instructionAttributes(instruction).functionIndex;
		if (typeof target !== "number" || target < 0) continue;
		const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
		if (fn.kernel.valueHandlerUseCount(value) !== 0) continue;
		let store: CoreInstructionId | undefined;
		let slot: number | undefined;
		const reads: Array<CoreInstructionId> = [];
		let valid = true;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const user = coreInstructionId(fn.kernel.useInstruction(use));
			if (fn.instructionKind(user) !== "operation") {
				valid = false;
				break;
			}
			const attributes = fn.instructionAttributes(user);
			if (
				fn.instructionOpcodeName(user) === "storeCaptured" &&
				attributes.functionIndex === fn.id &&
				typeof attributes.index === "number" &&
				attributes.index >= 0 &&
				fn.instructionBlock(user) === fn.instructionBlock(instruction)
			) {
				if (store !== undefined) {
					valid = false;
					break;
				}
				store = user;
				slot = attributes.index;
			} else reads.push(user);
		}
		if (valid && store !== undefined && slot !== undefined)
			candidates.push({
				owner: fn.id,
				closure: coreFunctionId(target),
				allocation: instruction,
				store,
				slot,
				reads,
				observers: new Set(),
				valid: true,
			});
		if (candidates.length > MAX_CLOSURES) return [];
	}
	return candidates;
}

function destination(
	fn: CoreFunctionStore,
	origin: CoreBlockId,
	demands: ReadonlyArray<CoreInstructionId>,
	compilation: ConstructedCoreCompilation,
): CoreBlockId | undefined {
	const flow = buildCoreControlFlow(compilation.program, fn.id);
	if ((flow.predecessors[fn.entry]?.length ?? 0) !== 0) return undefined;
	const initial = new Set<CoreBlockId>();
	let block = fn.entry;
	while (!initial.has(block) && initial.size < MAX_BRANCH_BLOCKS) {
		initial.add(block);
		const exit = coreTerminatorInput(fn, fn.blockTerminator(block));
		if (exit.kind !== "jump") break;
		const incoming = flow.predecessors[exit.edge.block] ?? [];
		if (incoming.length !== 1 || incoming[0]!.from !== block) break;
		block = exit.edge.block;
	}
	if (!initial.has(origin)) return undefined;
	const branches: Array<CoreBlockId> = [];
	const pendingBranches = [fn.entry];
	const visited = new Set<CoreBlockId>();
	while (pendingBranches.length > 0 && visited.size < MAX_BRANCH_BLOCKS) {
		const block = pendingBranches.shift()!;
		if (visited.has(block)) continue;
		visited.add(block);
		branches.push(block);
		for (const edge of flow.successors[block] ?? []) pendingBranches.push(edge.to);
	}
	let selected: CoreBlockId | undefined;
	for (const branch of branches) {
		const terminator = coreTerminatorInput(fn, fn.blockTerminator(branch));
		if (terminator.kind !== "branch") continue;
		const choices = [terminator.consequent.block, terminator.alternate.block];
		for (const target of choices) {
			const incoming = flow.predecessors[target] ?? [];
			if (
				target === fn.entry ||
				incoming.length !== 1 ||
				incoming[0]!.from !== branch ||
				flow.loops.some((loop) => loop.blocks.has(target)) ||
				flow.irreducibleCycles.some((cycle) => cycle.blocks.has(target)) ||
				!demands.every((instruction) =>
					flow.dominates(target, fn.instructionBlock(instruction)),
				)
			)
				continue;
			const other = choices[0] === target ? choices[1]! : choices[0]!;
			const pending = [other];
			const seen = new Set<CoreBlockId>();
			let returns = false;
			let reachesTarget = false;
			while (pending.length > 0 && seen.size < MAX_BRANCH_BLOCKS) {
				const block = pending.pop()!;
				if (block === target) {
					reachesTarget = true;
					break;
				}
				if (seen.has(block)) continue;
				seen.add(block);
				const exit = coreTerminatorInput(fn, fn.blockTerminator(block));
				returns ||= exit.kind === "return" || exit.kind === "throw";
				for (const edge of flow.successors[block] ?? []) pending.push(edge.to);
			}
			if (
				pending.length === 0 &&
				returns &&
				!reachesTarget &&
				(selected === undefined || flow.dominates(selected, target))
			)
				selected = target;
		}
	}
	return selected;
}

/** Delay captured allocations past early returns only while no observer can reach them. */
export function deferCapturedAllocations(
	compilation: ConstructedCoreCompilation,
): number {
	const { program, context } = compilation;
	if (
		context.facts.world.eval !== "disabled" ||
		context.facts.closure.sourceClosure.kind !== "known"
	)
		return 0;
	const candidates = new Map<CoreFunctionId, Map<number, Candidate>>();
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		const rest = candidate(fn);
		const found = closureCandidates(fn);
		if (rest !== undefined) found.push(rest);
		if (found.length === 0) continue;
		const slots = new Map<number, Candidate>();
		for (const entry of found) {
			const previous = slots.get(entry.slot);
			if (previous !== undefined) previous.valid = entry.valid = false;
			slots.set(entry.slot, entry);
		}
		candidates.set(id, slots);
	}
	if (candidates.size === 0) return 0;
	const creations = new Map<CoreFunctionId, Array<Creation>>();
	const reboundEnvironments = new Set<CoreFunctionId>();
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		const own = [...(candidates.get(id)?.values() ?? [])].find(
			(entry) => entry.closure === undefined,
		);
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			if (
				opcode === "createRestArguments" &&
				own !== undefined &&
				instruction !== own.allocation
			)
				own.valid = false;
			if (opcode.startsWith("with")) return 0;
			if (opcode.startsWith("env")) {
				reboundEnvironments.add(id);
				for (const found of candidates.get(id)?.values() ?? []) found.valid = false;
			}
			const attributes = fn.instructionAttributes(instruction);
			if (opcode === "createFunction" && typeof attributes.functionIndex === "number") {
				const target = coreFunctionId(attributes.functionIndex);
				const sites = creations.get(target) ?? [];
				sites.push({ caller: id, instruction });
				creations.set(target, sites);
			}
			const owner =
				typeof attributes.functionIndex === "number" && attributes.functionIndex >= 0
					? coreFunctionId(attributes.functionIndex)
					: undefined;
			const owned = owner === undefined ? undefined : candidates.get(owner);
			if (owned === undefined) continue;
			if (opcode === "createPrivateNames" && Array.isArray(attributes.capturedIndices))
				for (const index of attributes.capturedIndices) {
					const found = typeof index === "number" ? owned.get(index) : undefined;
					if (found !== undefined) found.valid = false;
				}
			const found =
				typeof attributes.index === "number" ? owned.get(attributes.index) : undefined;
			if (found === undefined) continue;
			if (
				opcode === "storeCaptured" &&
				(id !== found.owner || instruction !== found.store)
			)
				found.valid = false;
			if (opcode === "loadCaptured") {
				if (id === found.owner) found.reads.push(instruction);
				else found.observers.add(id);
			}
		}
	}
	let changed = 0;
	for (const [owner, slots] of candidates) {
		const closures = [...slots.values()].filter((entry) => entry.closure !== undefined);
		const groups = [
			closures,
			...[...slots.values()]
				.filter((entry) => entry.closure === undefined)
				.map((entry) => [entry]),
		];
		for (const group of groups) {
			if (group.length === 0 || group.some((entry) => !entry.valid)) continue;
			const internal = new Set(
				group.flatMap((entry) => (entry.closure === undefined ? [] : [entry.closure])),
			);
			const allocations = new Set(group.map((entry) => entry.allocation));
			if (
				group.some(
					(entry) =>
						entry.closure !== undefined &&
						!(
							creations
								.get(entry.closure)
								?.every(
									(site) => site.caller === owner && allocations.has(site.instruction),
								) ?? false
						),
				)
			)
				continue;
			const pending = group.flatMap((entry) => [...entry.observers]);
			const visited = new Set<CoreFunctionId>();
			const demands = group.flatMap((entry) => entry.reads);
			let valid = true;
			while (pending.length > 0 && valid && visited.size < MAX_OBSERVERS) {
				const observer = pending.pop()!;
				if (visited.has(observer)) continue;
				visited.add(observer);
				if (reboundEnvironments.has(observer)) {
					valid = false;
					break;
				}
				if (internal.has(observer)) continue;
				const sites = creations.get(observer);
				if (sites === undefined || sites.length === 0) {
					valid = false;
					break;
				}
				// An indirect descendant can pass on this activation's environment without reading the slot.
				for (const site of sites) {
					if (site.caller === owner) demands.push(site.instruction);
					else pending.push(site.caller);
				}
			}
			if (!valid || pending.length > 0 || demands.length === 0) continue;
			const fn = program.function(owner);
			const origin = fn.instructionBlock(group[0]!.allocation);
			if (group.some((entry) => fn.instructionBlock(entry.allocation) !== origin))
				continue;
			const target = destination(fn, origin, demands, compilation);
			if (target === undefined) continue;
			const editor = CoreEditor.open(program, owner);
			const before = coreInstructionId(fn.kernel.blockFirstInstruction(target));
			const moved = new Set(group.flatMap((entry) => [entry.allocation, entry.store]));
			for (const instruction of [...fn.bodyInstructionIds(origin)])
				if (moved.has(instruction)) editor.moveInstruction(instruction, target, before);
			editor.commit();
			changed += group.length;
		}
	}
	return changed;
}
