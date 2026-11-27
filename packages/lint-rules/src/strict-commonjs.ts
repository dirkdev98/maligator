import type { AstNode, Context, Rule } from "./types.ts";

const COMMONJS_EXTENSION = /\.c[jt]s$/u;
const COMMONJS_NAMES = new Set(["require", "module", "exports"]);
const MODULE_SYNTAX = new Set([
	"ImportDeclaration",
	"ExportAllDeclaration",
	"ExportDefaultDeclaration",
	"ExportNamedDeclaration",
]);

function isStrict(program: AstNode<"Program">): boolean {
	for (const statement of program.body) {
		if (statement.type !== "ExpressionStatement" || statement.directive === undefined)
			return false;
		if (statement.directive === "use strict") return true;
	}
	return false;
}

/** Whether the file reads `require`, `module` or `exports` without declaring them. */
function readsCommonjsBinding(context: Context): boolean {
	const scope = context.sourceCode.scopeManager.globalScope;
	if (scope === null) return false;
	// A configured Node environment declares them as globals without a definition.
	const declared = scope.variables.some(
		(variable) =>
			COMMONJS_NAMES.has(variable.name) &&
			variable.defs.length === 0 &&
			variable.references.length > 0,
	);
	return (
		declared ||
		scope.through.some((reference) => COMMONJS_NAMES.has(reference.identifier.name))
	);
}

/**
 * ES modules are always strict; a CommonJS file is sloppy unless it opts in. One
 * sloppy file costs the whole program: its functions can read the global object
 * through `this`, so the build keeps every installer that receiver could reach,
 * including the complete `process` implementation, and stops trimming unused
 * built-ins. Calls between strict and sloppy code also inline only when the callee
 * neither writes properties nor calls other code.
 */
export const strictCommonjs: Rule = {
	meta: {
		type: "suggestion",
		docs: {
			description: 'Require "use strict" in CommonJS files',
		},
		hasSuggestions: true,
		messages: {
			sloppy:
				'This CommonJS file is sloppy, so the build keeps installers and built-ins the program never uses. Start it with "use strict".',
			addDirective: 'Add "use strict" at the top of the file.',
		},
	},
	createOnce(context) {
		let importMeta = false;
		return {
			before() {
				importMeta = false;
			},
			MetaProperty(node) {
				if (node.meta.name === "import") importMeta = true;
			},
			"Program:exit"(program) {
				if (
					importMeta ||
					isStrict(program) ||
					program.body.some((statement) => MODULE_SYNTAX.has(statement.type))
				)
					return;
				if (!COMMONJS_EXTENSION.test(context.filename) && !readsCommonjsBinding(context))
					return;
				const first = program.body[0];
				context.report({
					loc: { line: 1, column: 0 },
					messageId: "sloppy",
					suggest: [
						{
							messageId: "addDirective",
							fix: (fixer) =>
								first === undefined
									? fixer.insertTextAfterRange([0, 0], '"use strict";\n')
									: fixer.insertTextBefore(first, '"use strict";\n'),
						},
					],
				});
			},
		};
	},
};
