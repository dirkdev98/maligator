import type { ESTree } from "meriyah";
import { expect, test } from "vitest";
import {
	ESTREE_CONTINUE,
	ESTREE_SKIP,
	ESTREE_STOP,
	traverseEstree,
} from "../src/estree-traversal.ts";

function identifier(name: string): ESTree.Identifier {
	return { type: "Identifier", name };
}

test("supports array roots, parent/context, and ignores metadata and non-node objects", () => {
	const left = identifier("left");
	const right = identifier("right");
	const expression = {
		type: "BinaryExpression",
		operator: "+",
		left,
		right,
		loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
		metadata: { hidden: identifier("not-a-structural-child") },
	} as ESTree.BinaryExpression & { metadata: unknown };
	const seen: Array<string> = [];

	const result = traverseEstree(
		[expression, null, { note: "not a node" }],
		(node, at) => {
			seen.push(`${at.context}:${at.parent?.type ?? "root"}:${node.type}`);
			return ESTREE_CONTINUE;
		},
		"ctx",
	);

	expect(result).toBe(ESTREE_CONTINUE);
	expect(seen).toEqual([
		"ctx:root:BinaryExpression",
		"ctx:BinaryExpression:Identifier",
		"ctx:BinaryExpression:Identifier",
	]);
});

test("skip prunes one subtree and stop terminates traversal", () => {
	const tree = {
		type: "Program",
		sourceType: "script",
		body: [
			{
				type: "ExpressionStatement",
				expression: {
					type: "CallExpression",
					callee: identifier("skip"),
					arguments: [identifier("hidden")],
					optional: false,
				},
			},
			{ type: "ExpressionStatement", expression: identifier("stop") },
			{ type: "ExpressionStatement", expression: identifier("unreached") },
		],
	} as ESTree.Program;
	const seen: Array<string> = [];

	const result = traverseEstree(tree, (node) => {
		if (node.type === "CallExpression") return ESTREE_SKIP;
		if (node.type === "Identifier" && node.name === "stop") return ESTREE_STOP;
		seen.push(node.type === "Identifier" ? node.name : node.type);
		return ESTREE_CONTINUE;
	});

	expect(result).toBe(ESTREE_STOP);
	expect(seen).toEqual(["Program", "ExpressionStatement", "ExpressionStatement"]);
});
