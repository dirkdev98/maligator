import { CORE_ANY_SCRIPT_AGGREGATE } from "./core-call-graph.ts";
import type { CoreCallGraph, CoreCallGraphNode } from "./core-call-graph.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreOptimizationReportBuilder } from "./core-optimization-report.ts";
import {
	CORE_PROGRAM_FLOW_BODY,
	CORE_PROGRAM_FLOW_CALLS,
	CORE_PROGRAM_FLOW_CFG,
	CORE_PROGRAM_FLOW_EXCEPTION,
	CORE_PROGRAM_FLOW_FACTS,
	CORE_PROGRAM_FLOW_MEMORY,
	CORE_PROGRAM_FLOW_REPRESENTATIONS,
	CORE_PROGRAM_FLOW_SPECIALIZATION,
} from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreProgram,
	CoreProgramFlowDomainMask,
} from "./core-store.ts";

export type CoreProgramFlowDimensionMask = number;

export const CORE_PROGRAM_FLOW_TARGETS = 1 << 0;
export const CORE_PROGRAM_FLOW_EFFECTS = 1 << 1;
export const CORE_PROGRAM_FLOW_ESCAPE = 1 << 2;
export const CORE_PROGRAM_FLOW_CONTAINMENT = 1 << 3;
export const CORE_PROGRAM_FLOW_RETURN_PROVENANCE = 1 << 4;
export const CORE_PROGRAM_FLOW_RETURN_KIND = 1 << 5;
export const CORE_PROGRAM_FLOW_RETURN_REPRESENTATION = 1 << 6;
export const CORE_PROGRAM_FLOW_REACHABILITY = 1 << 7;

export const CORE_PROGRAM_FLOW_RUNTIME_IDENTITY = 1 << 0;
export const CORE_PROGRAM_FLOW_INLINE_SOURCE = 1 << 1;

const FUNCTION_INDEX_ATTRIBUTES = [
	"functionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
] as const;

export const CORE_PROGRAM_FLOW_TARGET_CONSUMER = 0;
export const CORE_PROGRAM_FLOW_SUMMARY_CONSUMER = 1;
export const CORE_PROGRAM_FLOW_VALUE_KIND_CONSUMER = 2;
export const CORE_PROGRAM_FLOW_REACHABILITY_CONSUMER = 3;

export const CORE_PROGRAM_FLOW_SUMMARIES =
	CORE_PROGRAM_FLOW_EFFECTS |
	CORE_PROGRAM_FLOW_ESCAPE |
	CORE_PROGRAM_FLOW_CONTAINMENT |
	CORE_PROGRAM_FLOW_RETURN_PROVENANCE |
	CORE_PROGRAM_FLOW_RETURN_REPRESENTATION;

const ALL_PROGRAM_FLOW_DIMENSIONS =
	CORE_PROGRAM_FLOW_TARGETS |
	CORE_PROGRAM_FLOW_EFFECTS |
	CORE_PROGRAM_FLOW_ESCAPE |
	CORE_PROGRAM_FLOW_CONTAINMENT |
	CORE_PROGRAM_FLOW_RETURN_PROVENANCE |
	CORE_PROGRAM_FLOW_RETURN_KIND |
	CORE_PROGRAM_FLOW_RETURN_REPRESENTATION |
	CORE_PROGRAM_FLOW_REACHABILITY;

export class CoreProgramFlowLocalTransfers {
	readonly instructionVisits: number;
	readonly #operations: Uint32Array;
	readonly #calls: Uint32Array;
	readonly #cellAccesses: Uint32Array;
	readonly #propertyDefinitions: Uint32Array;
	readonly #structuralTargets: Uint32Array;
	readonly #structuralReasons: Uint8Array;

	constructor(
		instructionVisits: number,
		operations: ReadonlyArray<CoreInstructionId>,
		calls: ReadonlyArray<CoreInstructionId>,
		cellAccesses: ReadonlyArray<CoreInstructionId>,
		propertyDefinitions: ReadonlyArray<CoreInstructionId>,
		structuralTargets: ReadonlyArray<CoreFunctionId>,
		structuralReasons: ReadonlyArray<number>,
	) {
		this.instructionVisits = instructionVisits;
		this.#operations = Uint32Array.from(operations);
		this.#calls = Uint32Array.from(calls);
		this.#cellAccesses = Uint32Array.from(cellAccesses);
		this.#propertyDefinitions = Uint32Array.from(propertyDefinitions);
		this.#structuralTargets = Uint32Array.from(structuralTargets);
		this.#structuralReasons = Uint8Array.from(structuralReasons);
	}

	get operationCount(): number {
		return this.#operations.length;
	}

	operationAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#operations, index, "operation");
	}

	get callCount(): number {
		return this.#calls.length;
	}

	callAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#calls, index, "call");
	}

	get cellAccessCount(): number {
		return this.#cellAccesses.length;
	}

	cellAccessAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#cellAccesses, index, "cell access");
	}

	get propertyDefinitionCount(): number {
		return this.#propertyDefinitions.length;
	}

	propertyDefinitionAt(index: number): CoreInstructionId {
		return this.#instructionAt(this.#propertyDefinitions, index, "property definition");
	}

	get structuralTargetCount(): number {
		return this.#structuralTargets.length;
	}

	structuralTargetAt(index: number): CoreFunctionId {
		const target = this.#structuralTargets[index];
		if (target === undefined) throw new Error(`Unknown structural target ${index}`);
		return target as CoreFunctionId;
	}

	structuralReasonMaskAt(index: number): number {
		const reasons = this.#structuralReasons[index];
		if (reasons === undefined) throw new Error(`Unknown structural target ${index}`);
		return reasons;
	}

	get recordCount(): number {
		return (
			this.#operations.length +
			this.#calls.length +
			this.#cellAccesses.length +
			this.#propertyDefinitions.length +
			this.#structuralTargets.length
		);
	}

	#instructionAt(
		instructions: Uint32Array,
		index: number,
		kind: string,
	): CoreInstructionId {
		const instruction = instructions[index];
		if (instruction === undefined) throw new Error(`Unknown ${kind} transfer ${index}`);
		return coreInstructionId(instruction);
	}
}

function addStructuralTarget(
	targets: Map<CoreFunctionId, number>,
	program: CoreProgram,
	candidate: unknown,
	reason: number,
): void {
	if (
		typeof candidate !== "number" ||
		!Number.isSafeInteger(candidate) ||
		candidate < 0 ||
		candidate >= program.functionCapacity
	)
		return;
	const target = candidate as CoreFunctionId;
	if (!program.hasFunction(target)) return;
	targets.set(target, (targets.get(target) ?? 0) | reason);
}

function addSourceTargets(
	targets: Map<CoreFunctionId, number>,
	program: CoreProgram,
	initial: number,
): void {
	const seen = new Set<number>();
	let position = initial;
	while (
		position >= 0 &&
		position < program.sourcePositions.length &&
		!seen.has(position)
	) {
		seen.add(position);
		const source = program.sourcePositions[position]!;
		addStructuralTarget(
			targets,
			program,
			source.inlinedFunctionIndex,
			CORE_PROGRAM_FLOW_INLINE_SOURCE,
		);
		position = source.callerPosId ?? -1;
	}
}

export function extractCoreProgramFlowLocalTransfers(
	program: CoreProgram,
	fn: CoreFunctionStore,
): CoreProgramFlowLocalTransfers {
	const operations: Array<CoreInstructionId> = [];
	const calls: Array<CoreInstructionId> = [];
	const cellAccesses: Array<CoreInstructionId> = [];
	const propertyDefinitions: Array<CoreInstructionId> = [];
	const structural = new Map<CoreFunctionId, number>();
	let instructionVisits = 0;
	for (let raw = 0; raw < fn.instructionCapacity; raw++) {
		instructionVisits++;
		const instruction = coreInstructionId(raw);
		if (fn.kernel.instructionLive(instruction) === 0) continue;
		const sourcePosition = fn.kernel.instructionSourcePosition(instruction);
		if (sourcePosition >= 0) addSourceTargets(structural, program, sourcePosition);
		if (fn.kernel.instructionOpcode(instruction) < 0) continue;
		operations.push(instruction);
		const descriptor = fn.registry.byId(fn.instructionOpcode(instruction));
		if (descriptor.callTransfer !== undefined) calls.push(instruction);
		const opcode = descriptor.opcode;
		if (
			opcode === "loadGlobal" ||
			opcode === "storeGlobal" ||
			opcode === "loadCaptured" ||
			opcode === "storeCaptured"
		) {
			cellAccesses.push(instruction);
		}
		if (opcode === "defineProperty") propertyDefinitions.push(instruction);
		const attributes = fn.instructionAttributes(instruction);
		for (const key of FUNCTION_INDEX_ATTRIBUTES) {
			addStructuralTarget(
				structural,
				program,
				attributes[key],
				CORE_PROGRAM_FLOW_RUNTIME_IDENTITY,
			);
		}
		const guarded = attributes.guardedFunctionIndices;
		if (!Array.isArray(guarded)) continue;
		for (const target of guarded) {
			addStructuralTarget(
				structural,
				program,
				target,
				CORE_PROGRAM_FLOW_RUNTIME_IDENTITY,
			);
		}
	}
	const structuralTargets = [...structural.keys()].sort((left, right) => left - right);
	return new CoreProgramFlowLocalTransfers(
		instructionVisits,
		operations,
		calls,
		cellAccesses,
		propertyDefinitions,
		structuralTargets,
		structuralTargets.map((target) => structural.get(target)!),
	);
}

export interface CoreProgramFlowScc {
	readonly id: string;
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly hasAnyScriptAggregate: boolean;
}

export interface CoreProgramFlowTopology {
	readonly graph: CoreCallGraph;
	readonly sccs: ReadonlyArray<CoreProgramFlowScc>;
	readonly owner: ReadonlyMap<CoreCallGraphNode, number>;
	readonly nodesAnalyzed: number;
	readonly edgeVisits: number;
	readonly sccsReused: number;
}

export function buildCoreProgramFlowTopology(
	graph: CoreCallGraph,
	previous?: CoreProgramFlowTopology,
): CoreProgramFlowTopology {
	if (previous !== undefined && graph.changedNodes.size === 0) {
		return Object.freeze({
			graph,
			sccs: previous.sccs,
			owner: previous.owner,
			nodesAnalyzed: 0,
			edgeVisits: 0,
			sccsReused: previous.sccs.length,
		});
	}
	const all: Array<CoreCallGraphNode> = [
		...graph.functions,
		...(graph.hasAggregate() ? [CORE_ANY_SCRIPT_AGGREGATE] : []),
	];
	let edgeVisits = 0;
	let fullRebuild =
		previous === undefined ||
		graph.hasAggregate() ||
		previous.graph.hasAggregate() ||
		graph.functions.length !== previous.graph.functions.length ||
		graph.functions.some(
			(functionId, index) => functionId !== previous.graph.functions[index],
		);
	const affected = new Set<CoreCallGraphNode>();
	if (fullRebuild) {
		for (const node of all) affected.add(node);
	} else {
		for (const node of graph.changedNodes) affected.add(node);
		const queue = [...affected];
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const node = queue[cursor]!;
			if (node === CORE_ANY_SCRIPT_AGGREGATE) {
				fullRebuild = true;
				break;
			}
			const functionId = node;
			const neighbors = [
				...graph.exactCallers(functionId),
				...previous!.graph.exactCallers(functionId),
				...graph.exactOutgoing(functionId),
				...previous!.graph.exactOutgoing(functionId),
			];
			edgeVisits += neighbors.length;
			for (const neighbor of neighbors) {
				if (affected.has(neighbor)) continue;
				affected.add(neighbor);
				queue.push(neighbor);
			}
		}
		if (fullRebuild) {
			affected.clear();
			for (const node of all) affected.add(node);
		}
	}
	if (previous !== undefined && affected.size === 0) {
		return Object.freeze({
			graph,
			sccs: previous.sccs,
			owner: previous.owner,
			nodesAnalyzed: 0,
			edgeVisits,
			sccsReused: previous.sccs.length,
		});
	}

	let nextIndex = 0;
	const indices = new Map<CoreCallGraphNode, number>();
	const lowlinks = new Map<CoreCallGraphNode, number>();
	const stack: Array<CoreCallGraphNode> = [];
	const onStack = new Set<CoreCallGraphNode>();
	const components: Array<Array<CoreCallGraphNode>> = [];
	const visit = (node: CoreCallGraphNode): void => {
		indices.set(node, nextIndex);
		lowlinks.set(node, nextIndex++);
		stack.push(node);
		onStack.add(node);
		graph.visitSuccessors(node, (successor) => {
			edgeVisits++;
			if (!affected.has(successor)) return;
			if (!indices.has(successor)) {
				visit(successor);
				lowlinks.set(node, Math.min(lowlinks.get(node)!, lowlinks.get(successor)!));
			} else if (onStack.has(successor)) {
				lowlinks.set(node, Math.min(lowlinks.get(node)!, indices.get(successor)!));
			}
		});
		if (lowlinks.get(node) !== indices.get(node)) return;
		const component: Array<CoreCallGraphNode> = [];
		while (stack.length > 0) {
			const member = stack.pop()!;
			onStack.delete(member);
			component.push(member);
			if (member === node) break;
		}
		components.push(component.sort((left, right) => left - right));
	};
	for (const node of affected) {
		if (!indices.has(node)) visit(node);
	}
	const preserved = fullRebuild
		? []
		: (previous?.sccs.filter(
				(scc) =>
					scc.functions.every((functionId) => !affected.has(functionId)) &&
					!scc.hasAnyScriptAggregate,
			) ?? []);
	const rebuilt = components.map((nodes) => {
		const functions = nodes.filter(
			(node): node is CoreFunctionId => node !== CORE_ANY_SCRIPT_AGGREGATE,
		);
		return Object.freeze({
			id: `scc:${nodes.map((node) => (node === CORE_ANY_SCRIPT_AGGREGATE ? "any" : node)).join(",")}`,
			functions: Object.freeze(functions),
			hasAnyScriptAggregate: nodes.includes(CORE_ANY_SCRIPT_AGGREGATE),
		});
	});
	const sccs = Object.freeze([...preserved, ...rebuilt]);
	const owner = new Map<CoreCallGraphNode, number>();
	for (const [index, scc] of sccs.entries()) {
		for (const functionId of scc.functions) owner.set(functionId, index);
		if (scc.hasAnyScriptAggregate) owner.set(CORE_ANY_SCRIPT_AGGREGATE, index);
	}
	return Object.freeze({
		graph,
		sccs,
		owner,
		nodesAnalyzed: affected.size,
		edgeVisits,
		sccsReused: preserved.length,
	});
}

export function coreProgramFlowDimensionsForDomains(
	domains: CoreProgramFlowDomainMask,
): CoreProgramFlowDimensionMask {
	let dimensions = 0;
	if (
		(domains &
			(CORE_PROGRAM_FLOW_BODY |
				CORE_PROGRAM_FLOW_CFG |
				CORE_PROGRAM_FLOW_EXCEPTION |
				CORE_PROGRAM_FLOW_CALLS |
				CORE_PROGRAM_FLOW_FACTS)) !==
		0
	)
		dimensions |= ALL_PROGRAM_FLOW_DIMENSIONS;
	if ((domains & CORE_PROGRAM_FLOW_MEMORY) !== 0) {
		dimensions |=
			CORE_PROGRAM_FLOW_EFFECTS |
			CORE_PROGRAM_FLOW_ESCAPE |
			CORE_PROGRAM_FLOW_CONTAINMENT |
			CORE_PROGRAM_FLOW_RETURN_PROVENANCE;
	}
	if ((domains & CORE_PROGRAM_FLOW_REPRESENTATIONS) !== 0) {
		dimensions |= CORE_PROGRAM_FLOW_RETURN_KIND | CORE_PROGRAM_FLOW_RETURN_REPRESENTATION;
	}
	if ((domains & CORE_PROGRAM_FLOW_SPECIALIZATION) !== 0) {
		dimensions |= CORE_PROGRAM_FLOW_RETURN_PROVENANCE;
	}
	return dimensions;
}

export class CoreProgramFlowEpoch {
	#cursor = 0;
	#revision = 0;
	#epoch = 0;
	#membership = new Uint32Array(0);
	#domains = new Uint16Array(0);
	#dimensions = new Uint16Array(0);
	readonly #dirtyFunctions: Array<CoreFunctionId> = [];

	get revision(): number {
		return this.#revision;
	}

	get dirtyFunctionCount(): number {
		return this.#dirtyFunctions.length;
	}

	refresh(
		program: CoreProgram,
		dimensionMask: CoreProgramFlowDimensionMask,
		report?: CoreOptimizationReportBuilder,
	): this {
		const revision = program.programFlowRevision;
		if (revision === this.#revision) return this;
		this.#ensureCapacity(program.functionCapacity);
		this.#epoch++;
		if (this.#epoch === 0xffff_ffff) {
			this.#membership.fill(0);
			this.#epoch = 1;
		}
		this.#dirtyFunctions.length = 0;
		for (let cursor = this.#cursor; cursor < revision; cursor++) {
			const functionId = program.programFlowFunctionAt(cursor);
			const domains = program.programFlowDomainMaskAt(cursor);
			const dimensions = coreProgramFlowDimensionsForDomains(domains);
			if ((dimensions & dimensionMask) === 0) continue;
			if (this.#membership[functionId] !== this.#epoch) {
				this.#membership[functionId] = this.#epoch;
				this.#domains[functionId] = 0;
				this.#dimensions[functionId] = 0;
				this.#dirtyFunctions.push(functionId);
			}
			this.#domains[functionId] = this.#domains[functionId]! | domains;
			this.#dimensions[functionId] = this.#dimensions[functionId]! | dimensions;
		}
		this.#cursor = revision;
		this.#revision = revision;
		report?.increment("programFlowDirtyFunctions", this.#dirtyFunctions.length);
		return this;
	}

	dirtyFunctionAt(index: number): CoreFunctionId {
		const functionId = this.#dirtyFunctions[index];
		if (functionId === undefined)
			throw new Error(`Unknown dirty function index ${index}`);
		return functionId;
	}

	dirtyDomains(functionId: CoreFunctionId): CoreProgramFlowDomainMask {
		return this.#membership[functionId] === this.#epoch ? this.#domains[functionId]! : 0;
	}

	dirtyDimensions(functionId: CoreFunctionId): CoreProgramFlowDimensionMask {
		return this.#membership[functionId] === this.#epoch
			? this.#dimensions[functionId]!
			: 0;
	}

	#ensureCapacity(capacity: number): void {
		if (this.#membership.length >= capacity) return;
		const membership = new Uint32Array(capacity);
		membership.set(this.#membership);
		this.#membership = membership;
		const domains = new Uint16Array(capacity);
		domains.set(this.#domains);
		this.#domains = domains;
		const dimensions = new Uint16Array(capacity);
		dimensions.set(this.#dimensions);
		this.#dimensions = dimensions;
	}
}

export class CoreProgramFlowEngine {
	readonly #program: CoreProgram;
	readonly #report: CoreOptimizationReportBuilder | undefined;
	readonly #consumers: Array<CoreProgramFlowEpoch | undefined> = [];
	readonly #localTransfers: Array<CoreProgramFlowLocalTransfers | undefined> = [];
	#topology: CoreProgramFlowTopology | undefined;
	#reportedRevision = 0;
	#localRevision = 0;
	#localDataVersion = 0;
	#localSourcePositionsVersion = 0;

	constructor(program: CoreProgram, report?: CoreOptimizationReportBuilder) {
		this.#program = program;
		this.#report = report;
	}

	refresh(
		consumer: number,
		dimensions: CoreProgramFlowDimensionMask,
	): CoreProgramFlowEpoch {
		const revision = this.#program.programFlowRevision;
		this.#report?.increment(
			"programFlowJournalEntries",
			revision - this.#reportedRevision,
		);
		this.#reportedRevision = revision;
		const epoch = this.#consumers[consumer] ?? new CoreProgramFlowEpoch();
		this.#consumers[consumer] = epoch;
		epoch.refresh(this.#program, dimensions, this.#report);
		const count = epoch.dirtyFunctionCount;
		if (consumer === CORE_PROGRAM_FLOW_TARGET_CONSUMER) {
			this.#report?.increment("programFlowTargetWakeups", count);
		} else if (consumer === CORE_PROGRAM_FLOW_SUMMARY_CONSUMER) {
			this.#report?.increment("programFlowSummaryWakeups", count);
		} else if (consumer === CORE_PROGRAM_FLOW_VALUE_KIND_CONSUMER) {
			this.#report?.increment("programFlowValueKindWakeups", count);
		} else if (consumer === CORE_PROGRAM_FLOW_REACHABILITY_CONSUMER) {
			this.#report?.increment("programFlowReachabilityWakeups", count);
		}
		return epoch;
	}

	local(functionId: CoreFunctionId): CoreProgramFlowLocalTransfers {
		this.#invalidateLocalTransfers();
		const current = this.#localTransfers[functionId];
		if (current !== undefined) {
			this.#report?.increment("programFlowTransferReuses");
			return current;
		}
		const next = extractCoreProgramFlowLocalTransfers(
			this.#program,
			this.#program.function(functionId),
		);
		this.#localTransfers[functionId] = next;
		this.#report?.increment("programFlowLocalScans");
		this.#report?.increment("programFlowLocalInstructionVisits", next.instructionVisits);
		this.#report?.increment("programFlowTransferRecords", next.recordCount);
		return next;
	}

	topology(graph: CoreCallGraph): CoreProgramFlowTopology {
		if (this.#topology?.graph === graph) return this.#topology;
		const next = buildCoreProgramFlowTopology(graph, this.#topology);
		this.#topology = next;
		this.#report?.increment("sccNodes", next.nodesAnalyzed);
		this.#report?.increment("sccEdges", next.edgeVisits);
		return next;
	}

	#invalidateLocalTransfers(): void {
		const dataVersion = this.#program.programVersion("data");
		const sourcePositionsVersion = this.#program.programVersion("sourcePositions");
		if (
			dataVersion !== this.#localDataVersion ||
			sourcePositionsVersion !== this.#localSourcePositionsVersion
		) {
			this.#localTransfers.length = 0;
			this.#localDataVersion = dataVersion;
			this.#localSourcePositionsVersion = sourcePositionsVersion;
		}
		const revision = this.#program.programFlowRevision;
		for (let cursor = this.#localRevision; cursor < revision; cursor++) {
			if (
				(this.#program.programFlowDomainMaskAt(cursor) &
					(CORE_PROGRAM_FLOW_BODY | CORE_PROGRAM_FLOW_CALLS)) ===
				0
			)
				continue;
			this.#localTransfers[this.#program.programFlowFunctionAt(cursor)] = undefined;
		}
		this.#localRevision = revision;
	}
}
