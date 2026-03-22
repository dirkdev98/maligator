import type { ESTree } from "meriyah";
import type { ScopeInformation } from "./program-info.ts";
import type { ModuleInformation, ScriptInformation } from "./program-info.ts";
import type { ProgramInformation } from "./program-info.ts";

export class Transform {
	private program: ProgramInformation;
	public chunks: Record<string, string> = {};
	public chunkInits = new Set<string>();
	public chunkEntrypoint = new Set<string>();

	static includes() {
		return `
#include <stdio.h>
#include "env.h"
#include "thread.h"
#include "value.h"
#include "value_ops.h"
`;
	}

	constructor(program: ProgramInformation) {
		this.program = program;
	}

	do() {
		for (const { scriptOrModule } of this.program.iterateProgramEntries()) {
			this.handleScriptOrModule(scriptOrModule);
		}

		return this;
	}

	handleScriptOrModule(scriptOrModule: ScriptInformation | ModuleInformation) {
		this.chunkEntrypoint.add(scriptOrModule.chunkEntrypointSymbol());
		this.chunkInits.add(scriptOrModule.chunkInitSymbol());

		this.chunks[scriptOrModule.id] = this.compileRootScope(
			scriptOrModule,
			scriptOrModule.rootScope,
		);
	}

	private compileRootScope(
		scriptOrModule: ScriptInformation | ModuleInformation,
		scope: ScopeInformation,
	) {
		const parts = [
			Transform.includes(),

			this.compileFunctionForwardRefs(scriptOrModule, scope),

			this.compileModuleInit(scriptOrModule, scope),
			this.compileModuleEntrypoint(scriptOrModule, scope),
			this.compileFunctions(scriptOrModule, scope),
		];

		return parts.join("\n");
	}

	/**
	 * Compile execution of top-level statements.
	 */
	private compileModuleEntrypoint(
		scriptOrModule: ScriptInformation | ModuleInformation,
		_scope: ScopeInformation,
	) {
		const entrypointStatements = scriptOrModule.chunkEntryPointStatements();
		const compiledStatements = this.compileStatements(entrypointStatements);

		return `
    void ${scriptOrModule.chunkEntrypointSymbol()}(MalThread *thread, MalEnv *env) {
			thread->return_result = MAL_NORMAL;
			thread->return_value = mal_value_new_undefined();

      ${compiledStatements}  
    }
    `;
	}

	/**
	 * Compile hoisting of functions and variables.
	 */
	private compileModuleInit(
		scriptOrModule: ScriptInformation | ModuleInformation,
		_scope: ScopeInformation,
	) {
		return `
    void ${scriptOrModule.chunkInitSymbol()}(MalThread *thread, MalEnv *env) {
			thread->return_result = MAL_NORMAL;
			thread->return_value = mal_value_new_undefined();
    }
    `;
	}

	private compileFunctionForwardRefs(
		scriptOrModule: ScriptInformation | ModuleInformation,
		scope: ScopeInformation,
	) {
		const parts: Array<string> = [];

		const walkScope = (scope: ScopeInformation) => {
			if (scope.type === "function") {
				parts.push(`void ${scope.id}(MalThread *thread, MalEnv *env);`);
			}

			for (const child of scope.children) {
				walkScope(child);
			}
		};

		walkScope(scope);

		return parts.join("\n");
	}

	/**
	 * Compile functions
	 */
	private compileFunctions(
		scriptOrModule: ScriptInformation | ModuleInformation,
		scope: ScopeInformation,
	) {
		const parts: Array<string> = [];

		const walkScope = (scope: ScopeInformation) => {
			if (scope.type === "function") {
				parts.push(this.compileFunction(scriptOrModule, scope));
			}

			for (const child of scope.children) {
				walkScope(child);
			}
		};

		walkScope(scope);

		return parts.join("\n");
	}

	/**
	 * Compile top-level statements.
	 */
	private compileFunction(
		scriptOrModule: ScriptInformation | ModuleInformation,
		scope: ScopeInformation,
	) {
		if (scope.type !== "function") {
			throw new Error("Expected a function scope");
		}

		const stmts =
			scope.node.type === "FunctionDeclaration" && scope.node.body
				? scope.node.body.body
				: [];

		return `
void ${scope.id}(MalThread *thread, MalEnv *env) {
  thread->return_result = MAL_NORMAL;
  thread->return_value = mal_value_new_undefined();

${this.compileStatements(stmts)}
}`;
	}

	compileStatements(statements: Array<ESTree.Statement>) {
		const result = [];

		for (const stmt of statements) {
			result.push(this.compileStatement(stmt));
		}

		return result.join("\n");
	}

	compileStatement(statement: ESTree.Statement) {
		switch (statement.type) {
			case "ExpressionStatement":
				return this.compileExpressionStatement(statement);
			case "FunctionDeclaration":
				return " // Skipped function, this is hoisted elsewhere.";
			default:
				throw new Error(`Unsupported statement type: ${statement.type}`);
		}
	}

	compileExpressionStatement(expression: ESTree.ExpressionStatement) {
		if (expression.expression.type === "BinaryExpression") {
			return this.compileBinaryExpression(expression.expression);
		}

		throw new Error(`Unsupported expression type: ${expression.expression.type}`);
	}

	compileBinaryExpression(expression: ESTree.BinaryExpression) {
		if (expression.operator === "+") {
			return `mal_ops_add(thread, env, ${this.compileExpressionOrPrivateIdentifier(expression.left)}, ${this.compileExpressionOrPrivateIdentifier(expression.right)});`;
		}
	}

	compileExpressionOrPrivateIdentifier(
		expression: ESTree.Expression | ESTree.PrivateIdentifier,
	) {
		if (expression.type === "PrivateIdentifier") {
			throw new Error("Private identifiers are not supported");
		}

		return this.compileExpression(expression);
	}

	compileExpression(expression: ESTree.Expression) {
		if (expression.type === "Literal") {
			return this.compileLiteral(expression);
		}

		throw new Error(`Unsupported expression type: ${expression.type}`);
	}

	compileLiteral(literal: ESTree.Literal) {
		if (typeof literal.value === "number") {
			if (Number.isInteger(literal.value)) {
				return `mal_value_from_i32(${literal.value})`;
			}

			// return `mal_value_new_float(${literal.value})`;
		}

		throw new Error(`Unsupported literal type: ${literal.type}`);
	}
}
