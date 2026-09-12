import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import {
	CORE_ANY_SCRIPT_AGGREGATE,
	CoreCallerCursor,
	updateCoreCallGraph,
} from "../src/compiler/core/core-call-graph.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";

const id = (value: number) => value as CoreFunctionId;
const functions = [id(0), id(1), id(2)];

describe("Core call-graph canonical row reuse", () => {
	it("normalizes unsorted duplicate targets without retaining caller-owned arrays", () => {
		const targets = [id(1), id(0), id(1)];
		const graph = updateCoreCallGraph(undefined, functions, [
			{ caller: id(2), exactTargets: targets, wildcard: false },
			{ caller: id(0), exactTargets: [id(1)], wildcard: false },
		]);
		targets[0] = id(2);
		deepStrictEqual(graph.exactOutgoing(id(2)), [id(0), id(1)]);
		deepStrictEqual(graph.exactCallers(id(1)), [id(0), id(2)]);
		equal(graph.statistics.exactCallEdges, 3);
		equal(Object.isFrozen(graph.exactOutgoing(id(2))), true);
	});

	it("shares unchanged canonical rows while owning newly introduced sorted rows", () => {
		const targets = [id(0), id(1)];
		const rows = [{ caller: id(2), exactTargets: targets, wildcard: false }];
		const first = updateCoreCallGraph(undefined, functions, rows);
		const same = updateCoreCallGraph(first, functions, rows);
		equal(same.exactOutgoing(id(2)), first.exactOutgoing(id(2)));
		equal(same.exactCallers(id(0)), first.exactCallers(id(0)));
		equal(same.changedNodes.size, 0);
		targets.push(id(2));
		deepStrictEqual(first.exactOutgoing(id(2)), [id(0), id(1)]);
		deepStrictEqual(same.exactOutgoing(id(2)), [id(0), id(1)]);
	});

	it("invalidates removed edges and wildcard callers without duplicating visits", () => {
		const first = updateCoreCallGraph(undefined, functions, [
			{ caller: id(0), exactTargets: [id(1)], wildcard: false },
			{ caller: id(2), exactTargets: [id(0), id(1)], wildcard: false },
		]);
		const next = updateCoreCallGraph(first, functions, [
			{ caller: id(0), exactTargets: [id(1)], wildcard: false },
			{ caller: id(2), exactTargets: [id(1)], wildcard: true },
		]);
		deepStrictEqual(
			new Set(next.changedNodes),
			new Set([id(0), id(2), CORE_ANY_SCRIPT_AGGREGATE]),
		);
		deepStrictEqual(next.exactCallers(id(0)), []);
		const callers: Array<CoreFunctionId> = [];
		next.visitLogicalCallers(id(1), new CoreCallerCursor(3), (caller) =>
			callers.push(caller),
		);
		deepStrictEqual(callers, [id(0), id(2)]);
	});
});
