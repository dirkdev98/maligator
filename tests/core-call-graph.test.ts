import { readFileSync } from "node:fs";
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
			storedEntries: 14,
		});
	});

	it("indexes stable sparse function identities by capacity", () => {
		const functions = [2 as CoreFunctionId, 7 as CoreFunctionId];
		const graph = updateCoreCallGraph(undefined, functions, [
			{ caller: functions[1]!, exactTargets: [functions[0]!], wildcard: true },
		]);
		const callers: Array<CoreFunctionId> = [];
		graph.visitLogicalCallers(functions[0]!, new CoreCallerCursor(0), (caller) =>
			callers.push(caller),
		);

		expect(graph.isWildcardCaller(functions[1]!)).toBe(true);
		expect(callers).toEqual([functions[1]]);
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
			expect(graph.statistics.storedEntries).toBe(functionCount * 2 + wildcardCount);
			expect(visits).toBe(functionCount + wildcardCount);
		},
	);

	it("keeps call-sensitive consumers off dense wildcard compatibility paths", () => {
		const sources = [
			"src/compiler/core/core-ir-call-targets.ts",
			"src/compiler/core/core-ir-reachability.ts",
			"src/compiler/core/core-ir-summaries.ts",
			"src/compiler/core/core-ir-value-kinds.ts",
		].map((path) => readFileSync(path, "utf8"));
		for (const source of sources) {
			expect(source).not.toMatch(/targets\.callers\(/u);
			expect(source).not.toMatch(/programValueKindCallees/u);
			expect(source).not.toMatch(/specific(?:Outgoing|Reverse)Edges/u);
			expect(source).not.toMatch(/openSources/u);
		}
		expect(sources[0]).not.toMatch(/callers\(functionId/u);
		expect(sources[0]).not.toMatch(/versionKey:\s*string|functionVersionKey/u);
		expect(sources[1]).not.toMatch(
			/ReadonlyMap<CoreFunctionId, string>|functionVersionKey/u,
		);
		const facade = readFileSync(
			"src/compiler/core/core-program-flow-analysis.ts",
			"utf8",
		);
		expect(facade).toMatch(/programFlow\.refresh/);
		expect(facade).toMatch(/epoch\.dirtyFunctionAt/);
		expect(facade).toMatch(/programFlow\.local/);
		for (const path of [
			"src/compiler/core/core-ir-call-targets.ts",
			"src/compiler/core/core-ir-interprocedural-flow.ts",
			"src/compiler/core/core-ir-reachability.ts",
		]) {
			const source = readFileSync(path, "utf8");
			expect(source).not.toMatch(/\.instructionIds\(/u);
		}
	});
});
