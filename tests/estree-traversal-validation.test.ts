import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import {
	ESTREE_CONTINUE,
	ESTREE_SKIP,
	ESTREE_STOP,
	traverseEstree,
} from "../src/compiler/frontend/estree-traversal.ts";
import type { EstreeTraversalContext } from "../src/compiler/frontend/estree-traversal.ts";

describe("ESTree recursive-entry validation", () => {
	it("preserves preorder, parents, keys and separately retainable visitor contexts", () => {
		const spread = {
			type: "SpreadElement",
			argument: { type: "Identifier", name: "xs" },
		};
		const root = {
			type: "CallExpression",
			callee: { type: "Identifier", name: "f" },
			arguments: [{ type: "Literal", value: 1 }, spread],
			metadata: { type: "Identifier", name: "ignored" },
		};
		const context = { marker: 42 };
		const visits: Array<string> = [];
		const positions: Array<EstreeTraversalContext<typeof context>> = [];
		equal(
			traverseEstree(
				root,
				(node, at) => {
					visits.push(node.type);
					positions.push(at);
				},
				context,
			),
			ESTREE_CONTINUE,
		);
		deepStrictEqual(visits, [
			"CallExpression",
			"Identifier",
			"Literal",
			"SpreadElement",
			"Identifier",
		]);
		deepStrictEqual(
			positions.map((at) => at.key),
			[null, "callee", 0, 1, "argument"],
		);
		deepStrictEqual(
			positions.map((at) => at.parent),
			[null, root, root, root, spread],
		);
		equal(new Set(positions).size, positions.length);
		for (const at of positions) equal(at.context, context);
	});

	it("preserves skip and global stop across nested array roots", () => {
		const root = [
			[
				{ type: "UnaryExpression", argument: { type: "Identifier", name: "skipped" } },
				{ type: "Literal", value: 1 },
			],
			{ type: "Identifier", name: "after-stop" },
		];
		const visits: Array<string> = [];
		const result = traverseEstree(root, (node, at) => {
			equal(at.parent, null);
			visits.push(node.type);
			return node.type === "UnaryExpression" ? ESTREE_SKIP : ESTREE_STOP;
		});
		equal(result, ESTREE_STOP);
		deepStrictEqual(visits, ["UnaryExpression", "Literal"]);
	});

	it("retains future-node fallback and array dispatch even for arrays with type fields", () => {
		const typedArray = Object.assign([{ type: "Identifier", name: "child" }], {
			type: "Identifier",
		});
		const root = {
			type: "FutureNode",
			child: typedArray,
			nested: [null, [{ type: "Literal", value: 2 }]],
			metadata: { nested: { type: "Identifier", name: "not-a-child" } },
		};
		const visits: Array<string> = [];
		traverseEstree(root, (node) => {
			visits.push(node.type);
		});
		deepStrictEqual(visits, ["FutureNode", "Identifier", "Literal"]);
	});

	it("walks deeply nested scalar child slots without additional recursive dispatch layers", () => {
		let root: unknown = { type: "Identifier", name: "leaf" };
		for (let depth = 0; depth < 1000; depth++) {
			root = { type: "UnaryExpression", argument: root };
		}
		let count = 0;
		traverseEstree(root, () => {
			count++;
		});
		equal(count, 1001);
	});
});
