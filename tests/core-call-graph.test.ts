import { describe, expect, it } from "vitest";
import {
	CORE_ANY_SCRIPT_AGGREGATE,
	CoreCallerCursor,
	updateCoreCallGraph,
} from "../src/compiler/core/core-call-graph.ts";
import type { CoreCallGraphRow } from "../src/compiler/core/core-call-graph.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";

function functionIds(count: number): Array<CoreFunctionId> {
	return Array.from({ length: count }, (_, index) => index as CoreFunctionId);
}

function expandedCallers(
	functions: ReadonlyArray<CoreFunctionId>,
	rows: ReadonlyArray<CoreCallGraphRow>,
	target: CoreFunctionId,
): Array<CoreFunctionId> {
	return rows
		.filter((row) => row.wildcard || row.exactTargets.includes(target))
		.map(({ caller }) => caller)
		.filter((caller, index, callers) => callers.indexOf(caller) === index)
		.sort((left, right) => left - right)
		.filter((caller) => functions.includes(caller));
}

function reachability(
	functions: ReadonlyArray<CoreFunctionId>,
	rows: ReadonlyArray<CoreCallGraphRow>,
	entry: CoreFunctionId,
): Array<CoreFunctionId> {
	const outgoing = new Map(rows.map((row) => [row.caller, row]));
	const reached = new Set<CoreFunctionId>([entry]);
	const queue = [entry];
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const row = outgoing.get(queue[cursor]!);
		for (const target of row?.wildcard ? functions : (row?.exactTargets ?? [])) {
			if (reached.has(target)) continue;
			reached.add(target);
			queue.push(target);
		}
	}
	return [...reached].sort((left, right) => left - right);
}

function symbolicReachability(
	functions: ReadonlyArray<CoreFunctionId>,
	rows: ReadonlyArray<CoreCallGraphRow>,
	entry: CoreFunctionId,
): Array<CoreFunctionId> {
	const graph = updateCoreCallGraph(undefined, functions, rows);
	const reached = new Set<number>([entry]);
	const queue: Array<number> = [entry];
	for (let cursor = 0; cursor < queue.length; cursor++) {
		graph.visitSuccessors(queue[cursor]! as CoreFunctionId, (target) => {
			if (reached.has(target)) return;
			reached.add(target);
			queue.push(target);
		});
	}
	return [...reached]
		.filter((node) => node !== CORE_ANY_SCRIPT_AGGREGATE)
		.sort((left, right) => left - right) as Array<CoreFunctionId>;
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

describe("symbolic Core call graph", () => {
	it("streams exact and wildcard reverse callers without duplicates", () => {
		const functions = functionIds(4);
		const graph = updateCoreCallGraph(undefined, functions, [
			{ caller: functions[0]!, exactTargets: [functions[2]!], wildcard: true },
			{ caller: functions[1]!, exactTargets: [functions[2]!], wildcard: false },
			{ caller: functions[3]!, exactTargets: [], wildcard: true },
		]);
		const callers: Array<CoreFunctionId> = [];
		graph.visitLogicalCallers(functions[2]!, new CoreCallerCursor(4), (caller) =>
			callers.push(caller),
		);

		expect(callers).toEqual([functions[0], functions[1], functions[3]]);
		expect(graph.statistics).toEqual({
			functions: 4,
			exactCallEdges: 2,
			wildcardCallers: 2,
			aggregateDependencies: 4,
			storedRows: 4,
		});
	});

	it("matches an explicitly expanded reference for randomized small graphs", () => {
		for (let seed = 1; seed <= 100; seed++) {
			const next = random(seed);
			const functions = functionIds(2 + Math.floor(next() * 10));
			const rows = functions.map(
				(caller): CoreCallGraphRow => ({
					caller,
					exactTargets: functions.filter(() => next() < 0.2),
					wildcard: next() < 0.25,
				}),
			);
			const graph = updateCoreCallGraph(undefined, functions, rows);
			const cursor = new CoreCallerCursor(functions.length);
			for (const target of functions) {
				const callers: Array<CoreFunctionId> = [];
				graph.visitLogicalCallers(target, cursor, (caller) => callers.push(caller));
				expect(callers.sort((left, right) => left - right)).toEqual(
					expandedCallers(functions, rows, target),
				);
			}
			for (const entry of functions) {
				expect(symbolicReachability(functions, rows, entry)).toEqual(
					reachability(functions, rows, entry),
				);
			}
		}
	});

	it.each([
		[10, 1],
		[100, 10],
		[1_000, 100],
	] as const)(
		"stores functions plus wildcard sources linearly (%i functions, %i sources)",
		(functionCount, wildcardCount) => {
			const functions = functionIds(functionCount);
			const rows = functions.slice(0, wildcardCount).map((caller) => ({
				caller,
				exactTargets: [],
				wildcard: true,
			}));
			const graph = updateCoreCallGraph(undefined, functions, rows);
			let visits = 0;
			for (const caller of graph.wildcardCallers) {
				graph.visitSuccessors(caller, () => visits++);
			}
			graph.visitSuccessors(CORE_ANY_SCRIPT_AGGREGATE, () => visits++);

			expect(graph.statistics.storedRows).toBe(1);
			expect(visits).toBe(functionCount + wildcardCount);
		},
	);
});
