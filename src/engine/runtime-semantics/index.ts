import type { ESTree } from "meriyah";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import type { EngineValue } from "../types-and-values/data-types.ts";
import { BinaryExpression } from "./binary-expression.ts";
import { ExpressionStatement } from "./expression-statement.ts";
import { Literal } from "./literal-expression.ts";
import { LogicalExpression } from "./logical-expression.ts";

export const evaluators: Partial<{
	[K in ESTree.Node["type"]]: {
		evaluate(node: Extract<ESTree.Node, { type: K }>): CompletionRecord<EngineValue>;
	};
}> = {
	BinaryExpression,
	Literal,
	LogicalExpression,

	ExpressionStatement,
};

export function evaluate(node: ESTree.Node) {
	const evaluator = evaluators[node.type];

	if (!evaluator) {
		throw new Error(`No evaluator for node type: ${node.type}`);
	}

	// @ts-expect-error: node is typed
	return evaluator.evaluate(node);
}
