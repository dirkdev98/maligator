import type { CoreEditor } from "./core-editor.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import {
	buildCoreControlFlow,
	coreTerminatorInput,
	mapCoreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const MAX_SCOPE_SLOTS = 16;
const MAX_SCOPE_WORK = 4096;
const MAX_DEFINITION_DEPTH = 128;

type Body = ReadonlyMap<CoreBlockId, ReadonlyArray<CoreInstructionId>>;

interface Callback {
	readonly creation: CoreInstructionId;
	readonly call: CoreInstructionId;
	readonly slots: ReadonlySet<number>;
}

interface Scope {
	readonly id: number;
	readonly push: CoreInstructionId;
	readonly slots: number;
}

export function observesCaptureEnvironment(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
	return (
		opcode === "createArgumentsObject" ||
		opcode === "loadArgument" ||
		opcode === "loadArgumentCount" ||
		opcode === "createPrivateNames" ||
		opcode.startsWith("with") ||
		(opcode === "loadIntrinsic" &&
			fn.instructionAttributes(instruction).intrinsic === "__directEval")
	);
}

function creationUses(
	fn: CoreFunctionStore,
	creation: CoreInstructionId,
): ReadonlyArray<CoreInstructionId> | undefined {
	const kernel = fn.kernel;
	const value = kernel.resultAt(kernel.instructionResultStart(creation));
	if (kernel.valueHandlerUseCount(value) !== 0) return undefined;
	const users: Array<CoreInstructionId> = [];
	for (let use = kernel.valueFirstUse(value); use >= 0; use = kernel.useNext(use)) {
		if (kernel.useLive(use) === 0) continue;
		users.push(coreInstructionId(kernel.useInstruction(use)));
		if (users.length > 1) return undefined;
	}
	return users;
}

function guardedCallbacks(
	program: CoreProgram,
	fn: CoreFunctionStore,
	creations: ReadonlyArray<CoreInstructionId>,
	scopes: ReadonlyMap<number, Scope>,
): ReadonlyMap<number, ReadonlyMap<CoreInstructionId, Callback>> {
	const candidates = new Map<number, Map<CoreInstructionId, Callback>>();
	for (const creation of creations) {
		const uses = creationUses(fn, creation);
		if (uses?.length !== 1) continue;
		const call = uses[0]!;
		if (
			fn.instructionKind(call) !== "operation" ||
			fn.instructionOpcodeName(call) !== "call" ||
			fn.instructionAttributes(call)[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] !== true ||
			fn.instructionNext(call) !== fn.blockTerminator(fn.instructionBlock(call))
		)
			continue;
		const { functionIndex } = fn.instructionAttributes(creation);
		if (typeof functionIndex !== "number") continue;
		const target = program.function(functionIndex as CoreFunctionId);
		if (target.isAsync || target.isGenerator || target.metadata.mappedArguments) continue;
		const reads = new Map<number, Set<number>>();
		let safe = true;
		for (const block of target.blockIds()) {
			for (const instruction of target.bodyInstructionIds(block)) {
				const opcode = target.instructionOpcodeName(instruction);
				if (
					opcode === "createFunction" ||
					observesCaptureEnvironment(target, instruction)
				) {
					safe = false;
					break;
				}
				if (opcode !== "loadCaptured" && opcode !== "storeCaptured") continue;
				const { functionIndex, index } = target.instructionAttributes(instruction);
				if (typeof functionIndex !== "number" || typeof index !== "number") continue;
				const scope = scopes.get(functionIndex);
				if (scope === undefined) continue;
				if (opcode === "storeCaptured" || index < 0 || index >= scope.slots) {
					safe = false;
					break;
				}
				let slots = reads.get(scope.id);
				if (slots === undefined) {
					slots = new Set();
					reads.set(scope.id, slots);
				}
				slots.add(index);
			}
			if (!safe) break;
		}
		if (!safe) continue;
		for (const [scope, slots] of reads) {
			let callbacks = candidates.get(scope);
			if (callbacks === undefined) {
				callbacks = new Map();
				candidates.set(scope, callbacks);
			}
			callbacks.set(creation, { creation, call, slots });
		}
	}
	return candidates;
}

interface ScopePaths {
	readonly pops: ReadonlySet<CoreInstructionId>;
	readonly creations: ReadonlySet<CoreInstructionId>;
	readonly current: ReadonlySet<CoreInstructionId>;
}

function scopePaths(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	body: Body,
	scope: Scope,
): ScopePaths | undefined {
	const paths = new Map<CoreBlockId, Set<number>>();
	const pending: Array<{ block: CoreBlockId; depth: number }> = [];
	const pops = new Set<CoreInstructionId>();
	const otherPops = new Set<CoreInstructionId>();
	const creations = new Set<CoreInstructionId>();
	const current = new Set<CoreInstructionId>();
	const other = new Set<CoreInstructionId>();
	let work = 0;
	const visit = (block: CoreBlockId, depth: number) => {
		let depths = paths.get(block);
		if (depths === undefined) {
			depths = new Set();
			paths.set(block, depths);
		}
		if (depths.has(depth)) return;
		depths.add(depth);
		pending.push({ block, depth });
	};
	// Exceptional paths can reach a handler with different scopes. A pop must
	// have the same owner on every path that executes it.
	visit(fn.entry, -1);
	while (pending.length > 0) {
		if (++work > MAX_SCOPE_WORK) return undefined;
		const { block, depth: entryDepth } = pending.pop()!;
		let depth = entryDepth;
		const handler = fn.kernel.blockHandlerBlock(block);
		for (const instruction of body.get(block)!) {
			if (++work > MAX_SCOPE_WORK) return undefined;
			const opcode = fn.instructionOpcodeName(instruction);
			if (handler !== undefined && coreInstructionEffects(fn, instruction).mayThrow)
				visit(handler, depth);
			switch (opcode) {
				case "envPush":
					if (fn.instructionAttributes(instruction).scopeId === scope.id) {
						if (depth !== -1 || instruction !== scope.push) return undefined;
						depth = 0;
					} else if (depth >= 0) depth++;
					break;
				case "envCopy":
					if (
						(fn.instructionAttributes(instruction).scopeId === scope.id) !==
						(depth === 0)
					)
						return undefined;
					break;
				case "envPop":
					(depth === 0 ? pops : otherPops).add(instruction);
					if (depth >= 0) depth--;
					break;
				case "createFunction":
					if (depth >= 0) creations.add(instruction);
					(depth === 0 ? current : other).add(instruction);
					break;
				case "call":
					if (
						fn.instructionAttributes(instruction)[
							CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
						] === true
					)
						(depth === 0 ? current : other).add(instruction);
					break;
				case "loadCaptured":
				case "storeCaptured":
					if (
						fn.instructionAttributes(instruction).functionIndex === scope.id &&
						depth < 0
					)
						return undefined;
					break;
			}
		}
		if (
			handler !== undefined &&
			fn.instructionKind(fn.blockTerminator(block)) === "throw"
		)
			visit(handler, depth);
		for (const edge of cfg.successors[block] ?? []) {
			if (cfg.edges.kind(edge) === "ordinary") visit(cfg.edges.to(edge), depth);
		}
	}
	if ([...pops].some((pop) => otherPops.has(pop))) return undefined;
	for (const instruction of other) current.delete(instruction);
	return { pops, creations, current };
}

function sameCaptureLifetime(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	body: Body,
	{ creation, call }: Callback,
): boolean {
	const start = fn.instructionBlock(creation);
	const exit = fn.instructionBlock(call);
	if (!cfg.dominates(start, exit)) return false;
	const pending = [exit];
	const visited = new Set<CoreBlockId>();
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (visited.has(block)) continue;
		if (visited.size >= 32) return false;
		visited.add(block);
		const instructions = body.get(block)!;
		const end = block === exit ? instructions.indexOf(call) : instructions.length;
		let reached = false;
		for (let index = end - 1; index >= 0; index--) {
			const instruction = instructions[index]!;
			if (instruction === creation) {
				reached = true;
				break;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "envPush" || opcode === "envPop" || opcode === "envCopy")
				return false;
		}
		if (reached) continue;
		if (block === start) return false;
		for (const edge of cfg.predecessors[block] ?? []) {
			if (cfg.edges.kind(edge) !== "ordinary") return false;
			pending.push(cfg.edges.from(edge));
		}
	}
	return visited.has(start);
}

function fallbackKeepsCapturedValues(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	body: Body,
	scope: Scope,
	pops: ReadonlySet<CoreInstructionId>,
	{ call, slots }: Callback,
): boolean {
	const outgoing = (block: CoreBlockId) =>
		(cfg.successors[block] ?? []).map((edge) => cfg.edges.to(edge));
	const pending = outgoing(fn.instructionBlock(call));
	const visited = new Set<CoreBlockId>();
	let work = 0;
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (visited.has(block)) continue;
		visited.add(block);
		let rebound = false;
		const handler = fn.kernel.blockHandlerBlock(block);
		for (const instruction of body.get(block)!) {
			if (++work > MAX_SCOPE_WORK) return false;
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				pops.has(instruction) ||
				(opcode === "envCopy" &&
					fn.instructionAttributes(instruction).scopeId === scope.id)
			) {
				rebound = true;
				break;
			}
			if (opcode === "storeCaptured") {
				const { functionIndex, index } = fn.instructionAttributes(instruction);
				if (functionIndex === scope.id && typeof index === "number" && slots.has(index))
					return false;
			}
			if (handler !== undefined && coreInstructionEffects(fn, instruction).mayThrow)
				pending.push(handler);
		}
		if (!rebound) pending.push(...outgoing(block));
	}
	return true;
}

type SlotValue =
	| { readonly store: CoreInstructionId }
	| { readonly block: CoreBlockId; readonly incoming: Map<CoreBlockId, SlotValue> };

function slotDefinitions(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	body: Body,
	scope: Scope,
	pops: ReadonlySet<CoreInstructionId>,
) {
	const joins = Array.from(
		{ length: scope.slots },
		() => new Map<CoreBlockId, SlotValue>(),
	);
	let work = 0;
	const prefix = (
		slot: number,
		block: CoreBlockId,
		end: number,
		depth: number,
	): SlotValue | undefined => {
		if (depth === MAX_DEFINITION_DEPTH) return undefined;
		const instructions = body.get(block)!;
		for (let index = end - 1; index >= 0; index--) {
			if (++work > MAX_SCOPE_WORK) return undefined;
			const instruction = instructions[index]!;
			if (instruction === scope.push || pops.has(instruction)) return undefined;
			if (fn.instructionOpcodeName(instruction) !== "storeCaptured") continue;
			const { functionIndex, index: storedSlot } = fn.instructionAttributes(instruction);
			if (functionIndex === scope.id && storedSlot === slot)
				return { store: instruction };
		}
		const cache = joins[slot]!;
		const existing = cache.get(block);
		if (existing !== undefined) return existing;
		if (block === fn.entry || ++work > MAX_SCOPE_WORK) return undefined;
		const predecessors = cfg.predecessors[block] ?? [];
		// Handler arguments are separate from normal SSA edge arguments.
		if (
			predecessors.length === 0 ||
			predecessors.some((edge) => cfg.edges.kind(edge) !== "ordinary")
		)
			return undefined;
		const incoming = new Map<CoreBlockId, SlotValue>();
		const merge = { block, incoming };
		if (predecessors.length > 1) cache.set(block, merge);
		for (const edge of predecessors) {
			const source = cfg.edges.from(edge);
			if (incoming.has(source)) continue;
			const value = prefix(slot, source, body.get(source)!.length, depth + 1);
			if (value === undefined) return undefined;
			incoming.set(source, value);
		}
		const value = predecessors.length === 1 ? incoming.values().next().value! : merge;
		cache.set(block, value);
		return value;
	};
	return (instruction: CoreInstructionId, slot: number) => {
		const block = fn.instructionBlock(instruction);
		return prefix(slot, block, body.get(block)!.indexOf(instruction), 0);
	};
}

function virtualizeScope(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	cfg: CoreControlFlow,
	body: Body,
	scope: Scope,
	copies: ReadonlyArray<CoreInstructionId>,
	accesses: ReadonlyArray<CoreInstructionId>,
	callbacks: ReadonlyMap<CoreInstructionId, Callback>,
): number | undefined {
	const paths = scopePaths(fn, cfg, body, scope);
	if (paths === undefined || paths.pops.size === 0) return undefined;
	const unused: Array<CoreInstructionId> = [];
	const inScope: Array<Callback> = [];
	for (const creation of paths.creations) {
		const callback = callbacks.get(creation);
		if (callback === undefined) {
			if (creationUses(fn, creation)?.length !== 0) return undefined;
			unused.push(creation);
			continue;
		}
		if (
			!paths.current.has(creation) ||
			!paths.current.has(callback.call) ||
			!sameCaptureLifetime(fn, cfg, body, callback) ||
			!fallbackKeepsCapturedValues(fn, cfg, body, scope, paths.pops, callback)
		)
			return undefined;
		inScope.push(callback);
	}
	if (inScope.length === 0) return undefined;

	const definition = slotDefinitions(fn, cfg, body, scope, paths.pops);
	const loads = new Map<CoreInstructionId, SlotValue>();
	const storeValue = (store: CoreInstructionId) =>
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(store));
	const result = (load: CoreInstructionId) =>
		fn.kernel.resultAt(fn.kernel.instructionResultStart(load));
	for (const access of accesses) {
		if (fn.instructionOpcodeName(access) === "storeCaptured") {
			const representation = fn.valueRepresentation(storeValue(access));
			if (
				representation !== "boxed" &&
				representation !== "i32" &&
				representation !== "f64" &&
				representation !== "boolean"
			)
				return undefined;
			continue;
		}
		const { index } = fn.instructionAttributes(access);
		if (typeof index !== "number" || index < 0 || index >= scope.slots) return undefined;
		const value = definition(access, index);
		if (value === undefined || fn.valueRepresentation(result(access)) !== "boxed")
			return undefined;
		loads.set(access, value);
	}
	const snapshots: Array<{ callback: Callback; values: Map<number, SlotValue> }> = [];
	for (const callback of inScope) {
		const values = new Map<number, SlotValue>();
		for (const slot of callback.slots) {
			const value = definition(callback.call, slot);
			if (value === undefined) return undefined;
			values.set(slot, value);
		}
		snapshots.push({ callback, values });
	}

	let introduced = 0;
	const parameters = new Map<SlotValue, CoreValueId>();
	const boxedStores = new Map<CoreInstructionId, CoreValueId>();
	const materialize = (value: SlotValue): CoreValueId => {
		if ("store" in value) {
			const stored = storeValue(value.store);
			if (fn.valueRepresentation(stored) === "boxed") return stored;
			const existing = boxedStores.get(value.store);
			if (existing !== undefined) return existing;
			const boxed = editor.insertInstruction(
				fn.instructionBlock(value.store),
				value.store,
				"move",
				[stored],
				{ outputRepresentations: ["boxed"] },
			).outputs[0]!;
			boxedStores.set(value.store, boxed);
			introduced++;
			return boxed;
		}
		const existing = parameters.get(value);
		if (existing !== undefined) return existing;
		const parameter = editor.appendBlockParameter(value.block, {
			representation: "boxed",
		});
		parameters.set(value, parameter);
		for (const [source, incoming] of value.incoming) {
			const argument = materialize(incoming);
			editor.replaceTerminator(
				source,
				mapCoreTerminatorEdges(
					coreTerminatorInput(fn, fn.blockTerminator(source)),
					(edge) =>
						edge.block === value.block
							? { ...edge, arguments: [...edge.arguments, argument] }
							: edge,
				),
			);
		}
		return parameter;
	};
	for (const { callback, values } of snapshots) {
		const { creation, call } = callback;
		const block = fn.instructionBlock(call);
		const sourcePosition = fn.instructionSourcePosition(creation);
		if (fn.instructionBlock(creation) !== block || fn.instructionNext(creation) !== call)
			editor.moveInstruction(creation, block, call);
		editor.insertInstruction(block, creation, "envPush", [], {
			attributes: { scopeId: scope.id, slotCount: scope.slots },
			sourcePosition,
		});
		for (const [slot, value] of values) {
			editor.insertInstruction(block, creation, "storeCaptured", [materialize(value)], {
				attributes: { functionIndex: scope.id, index: slot },
				sourcePosition,
			});
		}
		// The closure owns the snapshot. Restore the caller scope before user code can
		// throw or retain the closure.
		editor.insertInstruction(block, call, "envPop", [], { sourcePosition });
		introduced += 2 + values.size;
	}
	for (const [load, value] of loads)
		editor.replaceValueUses(result(load), materialize(value));
	for (const instruction of [
		scope.push,
		...copies,
		...paths.pops,
		...accesses,
		...unused,
	])
		editor.removeInstruction(instruction);
	return introduced;
}

export function virtualizeIterationEnvironment(
	program: CoreProgram,
	functionId: CoreFunctionId,
	editor: CoreEditor,
): number | undefined {
	const fn = program.function(functionId);
	if (fn.isAsync || fn.isGenerator || fn.metadata.mappedArguments) return undefined;
	const scopes = new Map<number, Scope>();
	const copies = new Map<number, Array<CoreInstructionId>>();
	const accesses = new Map<number, Array<CoreInstructionId>>();
	const creations: Array<CoreInstructionId> = [];
	const body = new Map<CoreBlockId, ReadonlyArray<CoreInstructionId>>();
	let guarded = false;
	for (const block of fn.blockIds()) {
		const instructions = [...fn.bodyInstructionIds(block)];
		body.set(block, instructions);
		for (const instruction of instructions) {
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "envPush") {
				const { scopeId, slotCount } = fn.instructionAttributes(instruction);
				if (typeof scopeId !== "number" || scopeId >= 0 || typeof slotCount !== "number")
					return undefined;
				if (scopes.has(scopeId)) return undefined;
				if (slotCount > 0 && slotCount <= MAX_SCOPE_SLOTS)
					scopes.set(scopeId, { id: scopeId, push: instruction, slots: slotCount });
			} else if (opcode === "envCopy") {
				const { scopeId } = fn.instructionAttributes(instruction);
				if (typeof scopeId !== "number") return undefined;
				const list = copies.get(scopeId) ?? [];
				list.push(instruction);
				copies.set(scopeId, list);
			} else if (opcode === "loadCaptured" || opcode === "storeCaptured") {
				const { functionIndex } = fn.instructionAttributes(instruction);
				if (typeof functionIndex !== "number" || functionIndex >= 0) continue;
				const list = accesses.get(functionIndex) ?? [];
				list.push(instruction);
				accesses.set(functionIndex, list);
			} else if (opcode === "createFunction") creations.push(instruction);
			else if (
				opcode === "call" &&
				fn.instructionAttributes(instruction)[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] ===
					true
			)
				guarded = true;
		}
	}
	if (!guarded || copies.size === 0) return undefined;
	const plans = guardedCallbacks(program, fn, creations, scopes);
	if (plans.size === 0) return undefined;
	const cfg = buildCoreControlFlow(program, functionId);
	for (const [id, callbacks] of plans) {
		const scope = scopes.get(id)!;
		const scopeCopies = copies.get(id);
		const scopeAccesses = accesses.get(id);
		if (scopeCopies === undefined || scopeAccesses === undefined) continue;
		const introduced = virtualizeScope(
			fn,
			editor,
			cfg,
			body,
			scope,
			scopeCopies,
			scopeAccesses,
			callbacks,
		);
		if (introduced !== undefined) return introduced;
	}
	return undefined;
}
