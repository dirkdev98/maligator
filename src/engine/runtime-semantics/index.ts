import type { ESTree } from "meriyah";
import { CompletionUnwrapError } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import type { EngineValue } from "../types-and-values/data-types.ts";
import type { ReferenceRecord } from "../types-and-values/reference-record.ts";
import { ArrayExpression } from "./array-expression.ts";
import { AssignmentExpression } from "./assignment-expression.ts";
import { BinaryExpression } from "./binary-expression.ts";
import { BlockStatement } from "./block-statement.ts";
import { BreakStatement } from "./break-statement.ts";
import { CallExpression } from "./call-expression.ts";
import { ConditionalExpression } from "./conditional-expression.ts";
import { ContinueStatement } from "./continue-statement.ts";
import { DoWhileStatement } from "./do-while-statement.ts";
import { EmptyStatement } from "./empty-statement.ts";
import { ExpressionStatement } from "./expression-statement.ts";
import { FunctionDeclaration } from "./function-declaration.ts";
import { Identifier } from "./identifier.ts";
import { IfStatement } from "./if-statement.ts";
import { Literal } from "./literal-expression.ts";
import { LogicalExpression } from "./logical-expression.ts";
import { MemberExpression } from "./member-expression.ts";
import { NewExpression } from "./new-expression.ts";
import { ObjectExpression } from "./object-expression.ts";
import { ReturnStatement } from "./return-statement.ts";
import { SequenceExpression } from "./sequence-expression.ts";
import { SwitchStatement } from "./switch-statement.ts";
import { ThisExpression } from "./this-expression.ts";
import { ThrowStatement } from "./throw-statement.ts";
import { TryStatement } from "./try-statement.ts";
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
	// Expressions
	ArrayExpression,
	BinaryExpression,
	CallExpression,
	ConditionalExpression,
	Identifier,
	FunctionExpression: FunctionDeclaration as unknown as Evaluator<"FunctionExpression">,
	Literal,
	LogicalExpression,
	MemberExpression,
	NewExpression,
	ObjectExpression,
	SequenceExpression,
	ThisExpression,
	UnaryExpression,
	UpdateExpression,

	// Meta
	BlockStatement,
	Program: BlockStatement as unknown as Evaluator<"Program">,

	// Statements,
	AssignmentExpression,
	BreakStatement,
	ContinueStatement,
	DoWhileStatement,
	EmptyStatement,
	ExpressionStatement,
	IfStatement,
	ReturnStatement,
	SwitchStatement,
	ThrowStatement,
	TryStatement,
	VariableDeclaration,
	WhileStatement,

	/// Functions and classes
	FunctionDeclaration,
};

export function evaluate(node: ESTree.Node) {
	const evaluator = evaluators[node.type];

	if (!evaluator) {
		throw new Error(`No evaluator for node type: ${node.type}`);
	}

	try {
		// @ts-expect-error: node is typed
		return evaluator.evaluate(node);
	} catch (e) {
		if (e instanceof EvaluateError) {
			throw e;
		}

		if (e instanceof CompletionUnwrapError) {
			return e.completion;
		}

		// eslint-disable-next-line @typescript-eslint/only-throw-error
		throw new EvaluateError(e as Error, node);
	}
}

export class EvaluateError {
	error: Error;
	node: unknown;
	constructor(error: Error, node: ESTree.Node) {
		this.error = error;
		this.node = node;
	}
}
