import type { ESTree } from "meriyah";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import type { EngineValue } from "../types-and-values/data-types.ts";
import type { ReferenceRecord } from "../types-and-values/reference-record.ts";
import { AssignmentExpression } from "./assignment-expression.ts";
import { BinaryExpression } from "./binary-expression.ts";
import { BlockStatement } from "./block-statement.ts";
import { BreakStatement } from "./break-statement.ts";
import { CallExpression } from "./call-expression.ts";
import { ConditionalExpression } from "./conditional-expression.ts";
import { ContinueStatement } from "./continue-statement.ts";
import { DoWhileStatement } from "./do-while-statement.ts";
import { ExpressionStatement } from "./expression-statement.ts";
import { Identifier } from "./identifier.ts";
import { IfStatement } from "./if-statement.ts";
import { Literal } from "./literal-expression.ts";
import { LogicalExpression } from "./logical-expression.ts";
import { ReturnStatement } from "./return-statement.ts";
import { SequenceExpression } from "./sequence-expression.ts";
import { UnaryExpression } from "./unary-expression.ts";
import { UpdateExpression } from "./update-expression.ts";
import { VariableDeclaration } from "./variable-declaration.ts";
import { WhileStatement } from "./while-statement.ts";

export type Evaluator<K extends ESTree.Node["type"]> = {
	evaluate(
		node: Extract<ESTree.Node, { type: K }>,
	): CompletionRecord<EngineValue | ReferenceRecord | undefined>;
};

export const evaluators: Partial<{
	[K in ESTree.Node["type"]]: Evaluator<K>;
}> = {
	BinaryExpression,
	CallExpression,
	ConditionalExpression,
	Identifier,
	Literal,
	LogicalExpression,
	SequenceExpression,
	UnaryExpression,
	UpdateExpression,

	BlockStatement,
	Program: BlockStatement as unknown as Evaluator<"Program">,

	AssignmentExpression,
	BreakStatement,
	ContinueStatement,
	DoWhileStatement,
	ExpressionStatement,
	IfStatement,
	ReturnStatement,
	VariableDeclaration,
	WhileStatement,
};

export function evaluate(node: ESTree.Node) {
	const evaluator = evaluators[node.type];

	if (!evaluator) {
		throw new Error(`No evaluator for node type: ${node.type}`);
	}

	// @ts-expect-error: node is typed
	return evaluator.evaluate(node);
}
