/**
 * Bounded callee-target analysis: which ordinary script functions an SSA value,
 * a compiler-owned global slot, or a captured closure slot can hold.
 *
 * The lattice is a product of a sorted finite script-function set and two
 * independent loss bits, so losing one kind of precision never discards the
 * other. `opaque` records "some callable this analysis cannot name" and
 * deliberately keeps the named candidates, because a singleton plus an open
 * possibility is exactly the shape a guarded specialization consumes. Only
 * finite overflow past `CORE_CALLEE_TARGET_CAP` widens, and it widens to
 * `anyScript` rather than to a wrong answer.
 *
 * The solver is one dependency graph plus a monotone worklist. Every transfer
 * function here is the join of the node's in-edges — `createFunction` seeds a
 * singleton, `move`, loads, stores, and block arguments are identities — so
 * pushing a raised value along out-edges is exact, and no CFG is ever rebuilt in
 * a whole-program round.
 *
 * Soundness rests on the registry being the single declaration of which memory
 * an opcode names. Every write to `global-slot` or `captured-slot` either names
 * its cell and its stored value (`storeGlobal`, `storeCaptured`) or appears in
 * `SLOT_WRITERS_WITHOUT_NEW_CALLABLES` with the reason it cannot publish a
 * callable; anything else degrades its whole family. Host-installed slots are
 * opaque because the host, not this graph, writes them. Direct eval needs no
 * special case: the frontend marshals bindings into a scope object and writes
 * them back through ordinary stores, so an eval-mutated binding reaches its slot
 * as a store of an unresolvable value.
 */

import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import type {
	CoreAttributeObject,
	CoreInstruction,
	CoreOpcodeRegistry,
	CoreProgram,
	CoreValueId,
} from "./core-ir.ts";

/**
 * Largest finite target set kept per cell. The bound is a cost decision, not an
 * analysis one: past four candidates no consumer — guard chain, dispatch table,
 * or joined summary — pays for itself, and the cap is what keeps the solver's
 * lattice height, and therefore its running time, linear in program size.
 */
export const CORE_CALLEE_TARGET_CAP = 4;

/**
 * What a cell can hold, as seen by callee resolution.
 *
 * `functions` is sorted, deduplicated, and at most `CORE_CALLEE_TARGET_CAP`
 * long. `anyScript` means the finite set overflowed, so any script function may
 * flow here and `functions` is empty. `opaque` means a callable outside this
 * analysis's vocabulary — a builtin, a bound or native function, a Proxy, or an
 * unresolved producer — may also flow here, and it never erases `functions`.
 * Bottom (all empty and false) means no callable has been observed at all.
 */
export interface CoreCalleeTargets {
	readonly functions: ReadonlyArray<number>;
	readonly anyScript: boolean;
	readonly opaque: boolean;
}

const NO_FUNCTIONS: ReadonlyArray<number> = Object.freeze([]);

export const CORE_CALLEE_TARGETS_BOTTOM: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: false,
	opaque: false,
});

/** A callable this analysis cannot name, with no script candidate. */
export const CORE_CALLEE_TARGETS_OPAQUE: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: false,
	opaque: true,
});

/** More script functions than the cap; every named candidate is widened away. */
export const CORE_CALLEE_TARGETS_ANY_SCRIPT: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: true,
	opaque: false,
});

export function coreCalleeTargetsFunction(functionIndex: number): CoreCalleeTargets {
	return Object.freeze({
		functions: Object.freeze([functionIndex]),
		anyScript: false,
		opaque: false,
	});
}

export function coreCalleeTargetsEqual(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): boolean {
	return (
		left.anyScript === right.anyScript &&
		left.opaque === right.opaque &&
		left.functions.length === right.functions.length &&
		left.functions.every((entry, index) => entry === right.functions[index])
	);
}

/**
 * Component-wise join. Overflow past the cap widens the script component to
 * `anyScript`; the opacity bit is an independent logical or, so joining an
 * unresolvable source keeps every candidate already proven to reach the cell.
 */
export function joinCoreCalleeTargets(
	left: CoreCalleeTargets,
	right: CoreCalleeTargets,
): CoreCalleeTargets {
	const opaque = left.opaque || right.opaque;
	if (left.anyScript || right.anyScript) {
		return opaque ? ANY_SCRIPT_AND_OPAQUE : CORE_CALLEE_TARGETS_ANY_SCRIPT;
	}
	if (left.functions.length === 0 && right.functions.length === 0) {
		return opaque ? CORE_CALLEE_TARGETS_OPAQUE : CORE_CALLEE_TARGETS_BOTTOM;
	}
	const merged = new Set(left.functions);
	for (const entry of right.functions) merged.add(entry);
	if (merged.size > CORE_CALLEE_TARGET_CAP) {
		return opaque ? ANY_SCRIPT_AND_OPAQUE : CORE_CALLEE_TARGETS_ANY_SCRIPT;
	}
	return Object.freeze({
		functions: Object.freeze([...merged].sort((first, second) => first - second)),
		anyScript: false,
		opaque,
	});
}

const ANY_SCRIPT_AND_OPAQUE: CoreCalleeTargets = Object.freeze({
	functions: NO_FUNCTIONS,
	anyScript: true,
	opaque: true,
});

/** No callable has been observed: the cell is unreachable or uninitialized. */
export function coreCalleeTargetsIsBottom(targets: CoreCalleeTargets): boolean {
	return !targets.anyScript && !targets.opaque && targets.functions.length === 0;
}

/** A possibility this analysis could not name remains. */
export function coreCalleeTargetsAreOpen(targets: CoreCalleeTargets): boolean {
	return targets.anyScript || targets.opaque;
}

/**
 * The single script function this cell can hold, whether or not an open
 * possibility remains. A consumer that reads this must tolerate a live callee
 * that is not the named target.
 */
export function coreCalleeTargetsSingleFunction(
	targets: CoreCalleeTargets,
): number | undefined {
	return !targets.anyScript && targets.functions.length === 1
		? targets.functions[0]
		: undefined;
}

/**
 * The single script function this cell can hold, with every other possibility
 * ruled out. This is the only form a consumer may treat as an unguarded fact.
 */
export function coreCalleeTargetsClosedFunction(
	targets: CoreCalleeTargets,
): number | undefined {
	return coreCalleeTargetsAreOpen(targets)
		? undefined
		: coreCalleeTargetsSingleFunction(targets);
}

export interface CoreCalleeTargetStatistics {
	readonly nodes: number;
	readonly edges: number;
	/** Times a node's state strictly rose; bounded by nodes times the height. */
	readonly propagations: number;
}

export interface CoreCalleeTargetAnalysis {
	/** Targets of an SSA value; unknown values answer bottom. */
	targets(functionIndex: number, value: CoreValueId): CoreCalleeTargets;
	globalSlot(slot: number): CoreCalleeTargets;
	capturedSlot(owner: number, index: number): CoreCalleeTargets;
	readonly statistics: CoreCalleeTargetStatistics;
}

/**
 * Writers that name a slot family without naming a cell, and the reason each one
 * cannot publish a callable into a cell this analysis names. Anything else that
 * writes `global-slot` or `captured-slot` without naming its cell degrades that
 * whole family, so a newly added opcode is conservative by default.
 */
const SLOT_WRITERS_WITHOUT_NEW_CALLABLES: ReadonlySet<string> = new Set([
	// Declaration-initializes global var properties to undefined.
	"initGlobalVars",
	// Mints fresh hidden symbols, never a function object.
	"createPrivateNames",
	// A per-iteration environment is a sibling holding the same synthetic scope id
	// and slot indices, so a copied cell keeps the key whose join already covers
	// every value stored to it.
	"envPush",
	"envCopy",
	"envPop",
]);

function attributeNumber(instruction: CoreInstruction, key: string): number | undefined {
	const value = instruction.attributes[key];
	return typeof value === "number" ? value : undefined;
}

function capturedSlotKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

interface SlotOpacity {
	global: boolean;
	captured: boolean;
}

/**
 * Whether an unnamed writer forces a whole slot family open. Derived from the
 * registry so the answer cannot drift from the opcode's declared memory.
 */
function slotFamilyOpacity(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
): SlotOpacity {
	const opacity: SlotOpacity = { global: false, captured: false };
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (SLOT_WRITERS_WITHOUT_NEW_CALLABLES.has(instruction.opcode)) continue;
				for (const access of registry.get(instruction.opcode)?.accesses ?? []) {
					if (access.mode !== "write") continue;
					if (access.family !== "global-slot" && access.family !== "captured-slot") {
						continue;
					}
					const names =
						access.valueOperand !== undefined &&
						(access.attributes ?? []).every(
							(key) => attributeNumber(instruction, key) !== undefined,
						) &&
						(access.attributes ?? []).length > 0;
					if (names) continue;
					if (access.family === "global-slot") opacity.global = true;
					else opacity.captured = true;
				}
			}
		}
	}
	return opacity;
}

/**
 * Solve the program's callee-target lattice.
 *
 * Nodes are SSA values, compiler-owned global slots, and captured closure slots;
 * edges run producer to consumer. Every node's state can rise at most
 * `CORE_CALLEE_TARGET_CAP + 2` times (the set grows, then widens, then opens), so
 * the whole solve is O(cap * (nodes + edges)) — near-linear in program size for
 * the fixed cap.
 */
export function analyzeCoreCalleeTargets(
	program: CoreProgram,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
): CoreCalleeTargetAnalysis {
	const opacity = slotFamilyOpacity(program, registry);
	const valueBase = new Map<number, number>();
	const valueLimit = new Map<number, number>();
	const globalNodes = new Map<number, number>();
	const capturedNodes = new Map<string, number>();
	let nodeCount = 0;
	for (const fn of program.functions) {
		// Take the maximum rather than the last entry: a value id outside this
		// function's node range would silently alias another function's values.
		let limit = 0;
		for (const { id } of fn.values) limit = Math.max(limit, id + 1);
		valueBase.set(fn.functionIndex, nodeCount);
		valueLimit.set(fn.functionIndex, limit);
		nodeCount += limit;
	}
	const globalNode = (slot: number): number => {
		let node = globalNodes.get(slot);
		if (node === undefined) {
			node = nodeCount++;
			globalNodes.set(slot, node);
		}
		return node;
	};
	const capturedNode = (owner: number, index: number): number => {
		const key = capturedSlotKey(owner, index);
		let node = capturedNodes.get(key);
		if (node === undefined) {
			node = nodeCount++;
			capturedNodes.set(key, node);
		}
		return node;
	};

	const dependents = new Map<number, Array<number>>();
	const seeds = new Map<number, CoreCalleeTargets>();
	let edges = 0;
	const addEdge = (from: number, to: number): void => {
		const existing = dependents.get(from);
		if (existing === undefined) dependents.set(from, [to]);
		else existing.push(to);
		edges++;
	};
	const addSeed = (node: number, targets: CoreCalleeTargets): void => {
		const existing = seeds.get(node);
		seeds.set(
			node,
			existing === undefined ? targets : joinCoreCalleeTargets(existing, targets),
		);
	};

	for (const fn of program.functions) {
		const base = valueBase.get(fn.functionIndex)!;
		const valueNode = (value: CoreValueId): number => base + value;
		// Incoming arguments are supplied by callers this pass does not resolve.
		for (const parameter of fn.parameters) {
			addSeed(valueNode(parameter), CORE_CALLEE_TARGETS_OPAQUE);
		}
		const cfg = buildCoreControlFlow(fn, registry);
		for (const block of fn.blocks) {
			const incoming = cfg.predecessors[block.id] ?? [];
			for (const [index, parameter] of block.parameters.entries()) {
				if (parameter.role === "exception" || block.id === fn.entry) {
					addSeed(valueNode(parameter.value), CORE_CALLEE_TARGETS_OPAQUE);
					continue;
				}
				for (const edge of incoming) {
					// An exceptional edge's arguments start at the handler block's first
					// explicit parameter, past the implicit exception parameter.
					const argument =
						edge.kind === "exceptional"
							? edge.arguments[index - 1]
							: edge.arguments[index];
					if (argument === undefined) {
						addSeed(valueNode(parameter.value), CORE_CALLEE_TARGETS_OPAQUE);
						continue;
					}
					addEdge(valueNode(argument), valueNode(parameter.value));
				}
			}
			for (const instruction of block.instructions) {
				const source = instruction.inputs[0];
				const result = instruction.outputs[0];
				switch (instruction.opcode) {
					case "createFunction": {
						const target = attributeNumber(instruction, "functionIndex");
						if (result === undefined) break;
						addSeed(
							valueNode(result),
							target === undefined
								? CORE_CALLEE_TARGETS_OPAQUE
								: coreCalleeTargetsFunction(target),
						);
						continue;
					}
					// The uninitialized sentinel is not a callable: reading a slot that
					// still holds it throws before any call can observe it, so it
					// contributes nothing to the slot's target set.
					case "createEmpty":
						continue;
					case "move":
						if (source !== undefined && result !== undefined) {
							addEdge(valueNode(source), valueNode(result));
							continue;
						}
						break;
					case "loadGlobal": {
						const slot = attributeNumber(instruction, "index");
						if (slot !== undefined && result !== undefined) {
							addEdge(globalNode(slot), valueNode(result));
							continue;
						}
						break;
					}
					case "storeGlobal": {
						const slot = attributeNumber(instruction, "index");
						if (slot !== undefined && source !== undefined) {
							addEdge(valueNode(source), globalNode(slot));
						}
						continue;
					}
					case "loadCaptured": {
						const owner = attributeNumber(instruction, "functionIndex");
						const index = attributeNumber(instruction, "index");
						if (owner !== undefined && index !== undefined && result !== undefined) {
							addEdge(capturedNode(owner, index), valueNode(result));
							continue;
						}
						break;
					}
					case "storeCaptured": {
						const owner = attributeNumber(instruction, "functionIndex");
						const index = attributeNumber(instruction, "index");
						if (owner !== undefined && index !== undefined && source !== undefined) {
							addEdge(valueNode(source), capturedNode(owner, index));
						}
						continue;
					}
					default:
						break;
				}
				// A producer this analysis does not model degrades only its own results.
				for (const output of instruction.outputs) {
					addSeed(valueNode(output), CORE_CALLEE_TARGETS_OPAQUE);
				}
			}
		}
	}

	if (opacity.global) {
		for (const node of globalNodes.values()) addSeed(node, CORE_CALLEE_TARGETS_OPAQUE);
	}
	if (opacity.captured) {
		for (const node of capturedNodes.values()) {
			addSeed(node, CORE_CALLEE_TARGETS_OPAQUE);
		}
	}
	// The host installs its exports into these slots, so their writers are not in
	// this graph at all.
	for (const candidate of program.compilation?.hostInstallCandidates ?? []) {
		for (const { slot } of candidate.exports) {
			addSeed(globalNode(slot), CORE_CALLEE_TARGETS_OPAQUE);
		}
	}

	const state = new Array<CoreCalleeTargets>(nodeCount).fill(CORE_CALLEE_TARGETS_BOTTOM);
	const queued = new Uint8Array(nodeCount);
	const queue: Array<number> = [];
	let propagations = 0;
	const raise = (node: number, targets: CoreCalleeTargets): void => {
		const next = joinCoreCalleeTargets(state[node]!, targets);
		if (coreCalleeTargetsEqual(state[node]!, next)) return;
		state[node] = next;
		propagations++;
		if (queued[node] === 0) {
			queued[node] = 1;
			queue.push(node);
		}
	};
	for (const [node, targets] of seeds) raise(node, targets);
	while (queue.length > 0) {
		const node = queue.pop()!;
		queued[node] = 0;
		const targets = state[node]!;
		for (const dependent of dependents.get(node) ?? []) raise(dependent, targets);
	}

	return {
		targets(functionIndex: number, value: CoreValueId): CoreCalleeTargets {
			const base = valueBase.get(functionIndex);
			if (base === undefined || value >= valueLimit.get(functionIndex)!) {
				return CORE_CALLEE_TARGETS_BOTTOM;
			}
			return state[base + value] ?? CORE_CALLEE_TARGETS_BOTTOM;
		},
		globalSlot(slot: number): CoreCalleeTargets {
			const node = globalNodes.get(slot);
			return node === undefined ? CORE_CALLEE_TARGETS_BOTTOM : state[node]!;
		},
		capturedSlot(owner: number, index: number): CoreCalleeTargets {
			const node = capturedNodes.get(capturedSlotKey(owner, index));
			return node === undefined ? CORE_CALLEE_TARGETS_BOTTOM : state[node]!;
		},
		statistics: { nodes: nodeCount, edges, propagations },
	};
}

/**
 * Instruction attribute carrying a call site's bounded target set.
 *
 * Core-internal: the only target-visible product of this analysis is the
 * existing guarded `directFunctionIndex` lowering, so this attribute is dropped
 * at the Core-to-target boundary rather than lowered or serialized.
 */
export const CORE_CALLEE_TARGETS_ATTRIBUTE = "calleeTargets";

/** Attributes this analysis owns that never cross the Core-to-target boundary. */
export const CORE_INTERNAL_TARGET_ATTRIBUTES: ReadonlySet<string> = new Set([
	CORE_CALLEE_TARGETS_ATTRIBUTE,
]);

/**
 * Attribute form of a target set. Both loss bits are recorded so a later
 * consumer can tell a closed proof from a speculation without re-running the
 * analysis.
 */
export function coreCalleeTargetsAttribute(
	targets: CoreCalleeTargets,
): CoreAttributeObject {
	return {
		functions: [...targets.functions],
		anyScript: targets.anyScript,
		opaque: targets.opaque,
	};
}
