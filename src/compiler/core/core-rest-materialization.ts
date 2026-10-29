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
	readonly allocation: CoreInstructionId;
	readonly store: CoreInstructionId;
	readonly slot: number;
	readonly reads: Array<CoreInstructionId>;
	readonly observers: Set<CoreFunctionId>;
	valid: boolean;
}

function candidate(fn: CoreFunctionStore): Candidate | undefined {
	if (
		fn.isAsync ||
		fn.isGenerator ||
		fn.metadata.isClassConstructor ||
		fn.metadata.isDerivedConstructor ||
		fn.metadata.mappedArguments ||
		fn.handlerBlockCount !== 0 ||
		[...fn.factIds()].length !== 0
	)
		return undefined;
	for (const instruction of fn.bodyInstructionIds(fn.entry)) {
		if (
			fn.instructionOpcodeName(instruction) !== "createRestArguments" ||
			fn.instructionAttributes(instruction).startIndex !== 0
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

function destination(
	fn: CoreFunctionStore,
	demands: ReadonlyArray<CoreInstructionId>,
	compilation: ConstructedCoreCompilation,
): CoreBlockId | undefined {
	const flow = buildCoreControlFlow(compilation.program, fn.id);
	if ((flow.predecessors[fn.entry]?.length ?? 0) !== 0) return undefined;
	let branch = fn.entry;
	const visited = new Set<CoreBlockId>();
	while (!visited.has(branch)) {
		visited.add(branch);
		const terminator = coreTerminatorInput(fn, fn.blockTerminator(branch));
		if (terminator.kind !== "jump") break;
		const next = terminator.edge.block;
		if ((flow.predecessors[next]?.length ?? 0) !== 1) return undefined;
		branch = next;
	}
	const terminator = coreTerminatorInput(fn, fn.blockTerminator(branch));
	if (terminator.kind !== "branch") return undefined;
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
		while (pending.length > 0) {
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
		if (returns && !reachesTarget) return target;
	}
	return undefined;
}

/** Defer a rest array only while its binding cannot be observed. */
export function deferCapturedRestMaterialization(
	compilation: ConstructedCoreCompilation,
): number {
	const { program, context } = compilation;
	if (
		context.facts.world.eval !== "disabled" ||
		context.facts.closure.sourceClosure.kind !== "known"
	)
		return 0;
	const candidates = new Map<CoreFunctionId, Candidate>();
	for (const id of program.functionIds()) {
		const found = candidate(program.function(id));
		if (found !== undefined) candidates.set(id, found);
	}
	if (candidates.size === 0) return 0;
	const creations = new Map<CoreFunctionId, Array<Creation>>();
	const reboundEnvironments = new Set<CoreFunctionId>();
	for (const id of program.functionIds()) {
		const fn = program.function(id);
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			const own = candidates.get(id);
			if (
				opcode === "createRestArguments" &&
				own !== undefined &&
				instruction !== own.allocation
			)
				own.valid = false;
			if (opcode.startsWith("with")) return 0;
			if (opcode.startsWith("env")) {
				reboundEnvironments.add(id);
				if (own !== undefined) own.valid = false;
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
			const found = owner === undefined ? undefined : candidates.get(owner);
			if (found === undefined) continue;
			if (
				opcode === "createPrivateNames" &&
				Array.isArray(attributes.capturedIndices) &&
				attributes.capturedIndices.includes(found.slot)
			)
				found.valid = false;
			if (attributes.index !== found.slot) continue;
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
	for (const found of candidates.values()) {
		if (!found.valid) continue;
		const pending = [...found.observers];
		const visited = new Set<CoreFunctionId>();
		const demands = [...found.reads];
		while (pending.length > 0 && found.valid) {
			const observer = pending.pop()!;
			if (visited.has(observer)) continue;
			visited.add(observer);
			if (reboundEnvironments.has(observer)) {
				found.valid = false;
				break;
			}
			const sites = creations.get(observer);
			if (sites === undefined || sites.length === 0) {
				found.valid = false;
				break;
			}
			// An indirect descendant can pass on this activation's environment without reading the slot.
			for (const site of sites) {
				if (site.caller === found.owner) demands.push(site.instruction);
				else pending.push(site.caller);
			}
		}
		if (!found.valid || demands.length === 0) continue;
		const fn = program.function(found.owner);
		const target = destination(fn, demands, compilation);
		if (target === undefined) continue;
		const editor = CoreEditor.open(program, found.owner);
		const before = coreInstructionId(fn.kernel.blockFirstInstruction(target));
		editor.moveInstruction(found.allocation, target, before);
		editor.moveInstruction(found.store, target, before);
		editor.commit();
		changed++;
	}
	return changed;
}
