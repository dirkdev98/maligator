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
 * Call results join the same graph through one cell per function holding
 * everything that function returns. A call site depends on its callee cell
 * reactively: each finite target the callee is proven to hold opens an edge from
 * that target's return cell to the call's result exactly once, and an open callee
 * raises the result's matching open component at most once. Because a cell's
 * finite set only grows and only up to the cap before it widens away, the
 * whole-program solve stays one worklist with no rescan of calls or functions.
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
import { coreMemoryAccesses } from "./core-ir-memory.ts";
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
		return opaque ? CORE_CALLEE_TARGETS_TOP : CORE_CALLEE_TARGETS_ANY_SCRIPT;
	}
	if (left.functions.length === 0 && right.functions.length === 0) {
		return opaque ? CORE_CALLEE_TARGETS_OPAQUE : CORE_CALLEE_TARGETS_BOTTOM;
	}
	const merged = new Set(left.functions);
	for (const entry of right.functions) merged.add(entry);
	if (merged.size > CORE_CALLEE_TARGET_CAP) {
		return opaque ? CORE_CALLEE_TARGETS_TOP : CORE_CALLEE_TARGETS_ANY_SCRIPT;
	}
	return Object.freeze({
		functions: Object.freeze([...merged].sort((first, second) => first - second)),
		anyScript: false,
		opaque,
	});
}

/**
 * Every callable at once: any script function and any callable this analysis
 * cannot name. This is the lattice top.
 */
export const CORE_CALLEE_TARGETS_TOP: CoreCalleeTargets = Object.freeze({
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
	/**
	 * Return-cell edges and open-component raises a call site activated. Bounded by
	 * `CORE_CALLEE_TARGET_CAP + 2` per site, which is what keeps a resolvable call
	 * from turning the solve into a whole-program round.
	 */
	readonly callActivations: number;
}

export interface CoreCalleeTargetAnalysis {
	/** Targets of an SSA value; unknown values answer bottom. */
	targets(functionIndex: number, value: CoreValueId): CoreCalleeTargets;
	globalSlot(slot: number): CoreCalleeTargets;
	capturedSlot(owner: number, index: number): CoreCalleeTargets;
	/** Everything this function's ordinary returns can hand back to a caller. */
	returnTargets(functionIndex: number): CoreCalleeTargets;
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
	/** Named global cells whose writer does not name the value it stores. */
	readonly opaqueGlobalSlots: Set<number>;
	readonly opaqueCapturedSlots: Map<string, readonly [number, number]>;
}

/**
 * How far each slot writer forces the lattice open. Naming the cell and naming
 * the stored value are independent obligations, so they degrade independently:
 *
 * - A writer that cannot name its cell degrades its whole family, because any
 *   cell in it may now hold anything.
 * - A writer that names its cell but stores something other than an operand —
 *   `createTemplateObject` caches its own result in a private per-site slot —
 *   makes exactly that cell opaque.
 *
 * Cells come from the shared memory-access query rather than a second attribute
 * decoder here, so the answer cannot drift from the opcode's declared memory and
 * a verified effect refinement that removed the write removes it here too.
 */
function slotFamilyOpacity(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
): SlotOpacity {
	const opacity: SlotOpacity = {
		global: false,
		captured: false,
		opaqueGlobalSlots: new Set(),
		opaqueCapturedSlots: new Map(),
	};
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (SLOT_WRITERS_WITHOUT_NEW_CALLABLES.has(instruction.opcode)) continue;
				for (const access of coreMemoryAccesses(instruction, undefined, registry)) {
					if (access.mode !== "write") continue;
					const location = access.location;
					if (location.kind === "family") {
						if (location.family === "global-slot") opacity.global = true;
						else if (location.family === "captured-slot") opacity.captured = true;
						continue;
					}
					if (access.value !== undefined) continue;
					if (location.kind === "global-slot") {
						opacity.opaqueGlobalSlots.add(location.slot);
					} else if (location.kind === "captured-slot") {
						opacity.opaqueCapturedSlots.set(
							capturedSlotKey(location.owner, location.index),
							[location.owner, location.index],
						);
					}
				}
			}
		}
	}
	return opacity;
}

/**
 * One call site's reactive dependency on its callee cell.
 *
 * `activated` and `openRaised` make the dependency bounded: a callee cell's finite
 * set only grows and only to the cap before it widens away, so a site wires at
 * most `CORE_CALLEE_TARGET_CAP` return cells and raises each open component at
 * most once, however many times the callee cell rises.
 */
interface CallResultSite {
	readonly callee: number;
	readonly result: number;
	/** [[Construct]] rather than [[Call]], which changes what the result can be. */
	readonly construct: boolean;
	readonly activated: Set<number>;
	openRaised: "none" | "opaque" | "top";
}

/**
 * Solve the program's callee-target lattice.
 *
 * Nodes are SSA values, compiler-owned global slots, captured closure slots, and
 * one return cell per function; edges run producer to consumer. Every node's
 * state can rise at most `CORE_CALLEE_TARGET_CAP + 2` times (the set grows, then
 * widens, then opens), and every call site activates at most
 * `CORE_CALLEE_TARGET_CAP + 2` return-cell edges or open raises, so the whole
 * solve is O(cap * (nodes + edges + calls)) — near-linear in program size for
 * the fixed cap, with no round over calls or functions.
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
	const returnNodes = new Map<number, number>();
	const functionsByIndex = new Map(
		program.functions.map((fn) => [fn.functionIndex, fn] as const),
	);
	let nodeCount = 0;
	for (const fn of program.functions) {
		// Take the maximum rather than the last entry: a value id outside this
		// function's node range would silently alias another function's values.
		let limit = 0;
		for (const { id } of fn.values) limit = Math.max(limit, id + 1);
		valueBase.set(fn.functionIndex, nodeCount);
		valueLimit.set(fn.functionIndex, limit);
		nodeCount += limit;
		// Allocated for every function up front: a call site discovered mid-solve
		// must find its target's cell without growing the node universe.
		returnNodes.set(fn.functionIndex, nodeCount++);
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
	const callSites = new Map<number, Array<CallResultSite>>();
	let edges = 0;
	let callActivations = 0;
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
	const addCallSite = (callee: number, result: number, construct: boolean): void => {
		const site: CallResultSite = {
			callee,
			result,
			construct,
			activated: new Set(),
			openRaised: "none",
		};
		const existing = callSites.get(callee);
		if (existing === undefined) callSites.set(callee, [site]);
		else existing.push(site);
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
					default: {
						// The registry, not a list of opcode names here, decides which
						// operand a control transfer enters and whether the result it hands
						// back is related to what the callee returned at all.
						const transfer = registry.get(instruction.opcode)?.callTransfer;
						if (transfer === undefined || transfer.result === "unmodeled") break;
						const callee = instruction.inputs[transfer.calleeOperand];
						if (callee === undefined || result === undefined) break;
						addCallSite(
							valueNode(callee),
							valueNode(result),
							transfer.result === "construct-completion",
						);
						continue;
					}
				}
				// A producer this analysis does not model degrades only its own results.
				for (const output of instruction.outputs) {
					addSeed(valueNode(output), CORE_CALLEE_TARGETS_OPAQUE);
				}
			}
			// Every ordinary return contributes to the one cell a caller reads. A
			// generator's or an async function's returns land here too; what keeps a
			// caller from reading them is the coroutine rule in `activateCallSite`,
			// not a missing edge.
			if (block.terminator.kind === "return") {
				addEdge(valueNode(block.terminator.value), returnNodes.get(fn.functionIndex)!);
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
	for (const slot of opacity.opaqueGlobalSlots) {
		addSeed(globalNode(slot), CORE_CALLEE_TARGETS_OPAQUE);
	}
	for (const [owner, index] of opacity.opaqueCapturedSlots.values()) {
		addSeed(capturedNode(owner, index), CORE_CALLEE_TARGETS_OPAQUE);
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
	/**
	 * Wire what one call site has learned from its callee cell.
	 *
	 * The rules follow [[Call]] and [[Construct]], not the call syntax:
	 *
	 * - An opaque callee contributes an opaque result while finite named callees
	 *   still contribute their return cells. This preserves guarded candidates and
	 *   their fallback. A callee widened to `anyScript` has lost those bounded
	 *   candidates, so its result goes to top without enumerating every function.
	 * - A generator or async target returns its coroutine's promise, generator, or
	 *   async-generator object, never the value its body returns, and none of those
	 *   objects is callable — so it contributes nothing. The body's return value
	 *   reaches a consumer only through `await` or `iteratorNext`, whose results
	 *   this analysis leaves opaque.
	 * - `new` on a derived constructor completes with the object its own `super()`
	 *   bound as `this` whenever the body returns anything that is not an object.
	 *   No Core value names that object, so an opaque alternative accompanies its
	 *   explicit return targets.
	 * - Otherwise the result is the target's return cell. For [[Construct]] that
	 *   covers the one callable case — an explicitly returned function object —
	 *   because the object [[Construct]] creates for an ordinary constructor is a
	 *   plain object and can never be called.
	 * - A target outside this program is not a cell at all, so it is open.
	 */
	const activateCallSite = (site: CallResultSite): void => {
		const callee = state[site.callee]!;
		if (callee.anyScript) {
			if (site.openRaised === "top") return;
			site.openRaised = "top";
			callActivations++;
			raise(site.result, CORE_CALLEE_TARGETS_TOP);
			return;
		}
		if (callee.opaque && site.openRaised === "none") {
			site.openRaised = "opaque";
			callActivations++;
			raise(site.result, CORE_CALLEE_TARGETS_OPAQUE);
		}
		for (const target of callee.functions) {
			if (site.activated.has(target)) continue;
			site.activated.add(target);
			callActivations++;
			const targetFunction = functionsByIndex.get(target);
			if (targetFunction === undefined) {
				raise(site.result, CORE_CALLEE_TARGETS_OPAQUE);
				continue;
			}
			if (targetFunction.isGenerator || targetFunction.isAsync) continue;
			if (site.construct && targetFunction.metadata.isDerivedConstructor) {
				raise(site.result, CORE_CALLEE_TARGETS_OPAQUE);
			}
			const returnNode = returnNodes.get(target)!;
			addEdge(returnNode, site.result);
			raise(site.result, state[returnNode]!);
		}
	};

	for (const [node, targets] of seeds) raise(node, targets);
	while (queue.length > 0) {
		const node = queue.pop()!;
		queued[node] = 0;
		const targets = state[node]!;
		for (const dependent of dependents.get(node) ?? []) raise(dependent, targets);
		for (const site of callSites.get(node) ?? []) activateCallSite(site);
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
		returnTargets(functionIndex: number): CoreCalleeTargets {
			const node = returnNodes.get(functionIndex);
			return node === undefined ? CORE_CALLEE_TARGETS_BOTTOM : state[node]!;
		},
		statistics: { nodes: nodeCount, edges, propagations, callActivations },
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
