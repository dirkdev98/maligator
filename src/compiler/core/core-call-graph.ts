import type { CoreFunctionId } from "./core-ir.ts";

export const CORE_ANY_SCRIPT_AGGREGATE = -1 as const;
export type CoreCallGraphNode = CoreFunctionId | typeof CORE_ANY_SCRIPT_AGGREGATE;

export interface CoreCallGraphRow {
	readonly caller: CoreFunctionId;
	readonly exactTargets: ReadonlyArray<CoreFunctionId>;
	readonly wildcard: boolean;
}

export interface CoreCallGraphStatistics {
	readonly functions: number;
	readonly exactCallEdges: number;
	readonly wildcardCallers: number;
	readonly aggregateDependencies: number;
	readonly storedRows: number;
}

function normalizedTargets(
	targets: ReadonlyArray<CoreFunctionId>,
): ReadonlyArray<CoreFunctionId> {
	return Object.freeze([...new Set(targets)].sort((left, right) => left - right));
}

function sameNumbers(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
	return (
		left.length === right.length && left.every((value, index) => value === right[index])
	);
}

export class CoreCallerCursor {
	#marks: Uint32Array;
	#epoch = 0;

	constructor(functionCapacity: number) {
		this.#marks = new Uint32Array(functionCapacity);
	}

	begin(functionCapacity: number): void {
		if (this.#marks.length < functionCapacity) {
			this.#marks = new Uint32Array(functionCapacity);
			this.#epoch = 1;
			return;
		}
		this.#epoch++;
		if (this.#epoch !== 0xffff_ffff) return;
		this.#marks.fill(0);
		this.#epoch = 1;
	}

	mark(functionId: CoreFunctionId): boolean {
		if (this.#marks[functionId] === this.#epoch) return false;
		this.#marks[functionId] = this.#epoch;
		return true;
	}
}

export class CoreCallGraph {
	readonly functions: ReadonlyArray<CoreFunctionId>;
	readonly wildcardCallers: ReadonlyArray<CoreFunctionId>;
	readonly changedNodes: ReadonlySet<CoreCallGraphNode>;
	readonly statistics: CoreCallGraphStatistics;
	readonly #exactOutgoing: ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreFunctionId>>;
	readonly #exactCallers: ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreFunctionId>>;
	readonly #wildcardCallerMarks: Uint8Array;

	constructor(
		functions: ReadonlyArray<CoreFunctionId>,
		exactOutgoing: ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreFunctionId>>,
		exactCallers: ReadonlyMap<CoreFunctionId, ReadonlyArray<CoreFunctionId>>,
		wildcardCallers: ReadonlyArray<CoreFunctionId>,
		changedNodes: ReadonlySet<CoreCallGraphNode>,
	) {
		this.functions = Object.freeze([...functions]);
		this.#exactOutgoing = exactOutgoing;
		this.#exactCallers = exactCallers;
		this.wildcardCallers = Object.freeze([...wildcardCallers]);
		this.#wildcardCallerMarks = new Uint8Array(functions.length);
		for (const caller of wildcardCallers) this.#wildcardCallerMarks[caller] = 1;
		this.changedNodes = changedNodes;
		const exactCallEdges = [...exactOutgoing.values()].reduce(
			(total, row) => total + row.length,
			0,
		);
		this.statistics = Object.freeze({
			functions: functions.length,
			exactCallEdges,
			wildcardCallers: wildcardCallers.length,
			aggregateDependencies: wildcardCallers.length === 0 ? 0 : functions.length,
			storedRows:
				exactOutgoing.size + exactCallers.size + (wildcardCallers.length === 0 ? 0 : 1),
		});
	}

	hasAggregate(): boolean {
		return this.wildcardCallers.length > 0;
	}

	exactOutgoing(functionId: CoreFunctionId): ReadonlyArray<CoreFunctionId> {
		return this.#exactOutgoing.get(functionId) ?? [];
	}

	exactCallers(functionId: CoreFunctionId): ReadonlyArray<CoreFunctionId> {
		return this.#exactCallers.get(functionId) ?? [];
	}

	isWildcardCaller(functionId: CoreFunctionId): boolean {
		return this.#wildcardCallerMarks[functionId] === 1;
	}

	visitSuccessors(
		node: CoreCallGraphNode,
		visit: (node: CoreCallGraphNode) => void,
	): void {
		if (node === CORE_ANY_SCRIPT_AGGREGATE) {
			for (const functionId of this.functions) visit(functionId);
			return;
		}
		for (const callee of this.exactOutgoing(node)) visit(callee);
		if (this.isWildcardCaller(node)) visit(CORE_ANY_SCRIPT_AGGREGATE);
	}

	visitPredecessors(
		node: CoreCallGraphNode,
		visit: (node: CoreCallGraphNode) => void,
	): void {
		if (node === CORE_ANY_SCRIPT_AGGREGATE) {
			for (const caller of this.wildcardCallers) visit(caller);
			return;
		}
		for (const caller of this.exactCallers(node)) visit(caller);
		if (this.hasAggregate()) visit(CORE_ANY_SCRIPT_AGGREGATE);
	}

	visitLogicalCallers(
		functionId: CoreFunctionId,
		cursor: CoreCallerCursor,
		visit: (caller: CoreFunctionId) => void,
	): void {
		cursor.begin(this.functions.length);
		for (const caller of this.exactCallers(functionId)) {
			if (cursor.mark(caller)) visit(caller);
		}
		for (const caller of this.wildcardCallers) {
			if (cursor.mark(caller)) visit(caller);
		}
	}
}

export function updateCoreCallGraph(
	previous: CoreCallGraph | undefined,
	functions: ReadonlyArray<CoreFunctionId>,
	rows: ReadonlyArray<CoreCallGraphRow>,
): CoreCallGraph {
	const outgoing = new Map<CoreFunctionId, ReadonlyArray<CoreFunctionId>>();
	const reverse = new Map<CoreFunctionId, Array<CoreFunctionId>>();
	const wildcardCallers: Array<CoreFunctionId> = [];
	for (const row of rows) {
		const normalized = normalizedTargets(row.exactTargets);
		const priorTargets = previous?.exactOutgoing(row.caller) ?? [];
		const targets = sameNumbers(priorTargets, normalized) ? priorTargets : normalized;
		if (targets.length > 0) outgoing.set(row.caller, targets);
		for (const target of targets) {
			const callers = reverse.get(target) ?? [];
			callers.push(row.caller);
			reverse.set(target, callers);
		}
		if (row.wildcard) wildcardCallers.push(row.caller);
	}
	wildcardCallers.sort((left, right) => left - right);
	const exactCallers = new Map(
		[...reverse].map(([target, callers]) => {
			const normalized = Object.freeze(
				[...new Set(callers)].sort((left, right) => left - right),
			);
			const priorCallers = previous?.exactCallers(target) ?? [];
			return [target, sameNumbers(priorCallers, normalized) ? priorCallers : normalized];
		}),
	);
	const changed = new Set<CoreCallGraphNode>();
	for (const functionId of functions) {
		if (
			!sameNumbers(
				previous?.exactOutgoing(functionId) ?? [],
				outgoing.get(functionId) ?? [],
			)
		) {
			changed.add(functionId);
		}
		if (
			!sameNumbers(
				previous?.exactCallers(functionId) ?? [],
				exactCallers.get(functionId) ?? [],
			)
		) {
			changed.add(functionId);
		}
	}
	if (
		!sameNumbers(previous?.wildcardCallers ?? [], wildcardCallers) ||
		!sameNumbers(previous?.functions ?? [], functions)
	) {
		changed.add(CORE_ANY_SCRIPT_AGGREGATE);
		for (const caller of previous?.wildcardCallers ?? []) changed.add(caller);
		for (const caller of wildcardCallers) changed.add(caller);
	}
	return new CoreCallGraph(
		functions,
		outgoing,
		exactCallers,
		wildcardCallers,
		Object.freeze(changed),
	);
}
