import type { ESTree } from "meriyah";
import { traverseEstree } from "./estree-traversal.ts";

/**
 * Static detection of a CommonJS module's named exports — a pragmatic
 * cjs-module-lexer-style scan. Used to give `import * as ns from "cjs"` real
 * named keys, to expand `export * from "cjs"`, and to classify a module as
 * foldable pure data.
 *
 * It recognizes the common assignment shapes and is deliberately conservative:
 * when it meets a pattern it cannot enumerate (computed key, `module.exports =`
 * a non-literal, a spread, `Object.assign`, …) it flags `complete = false` and
 * the detected name set is treated as best-effort (a missing named import is
 * `undefined`, exactly as in Node). It never invents a name that is not written
 * somewhere in the source.
 */

export interface CjsExportInfo {
	/** Statically-detected named export names (never includes "default"). */
	names: Set<string>;
	/**
	 * True only if the export set is provably complete — no dynamic mutation that
	 * could add or remove names the scan cannot see. Required for pure-data
	 * folding; informational for namespace / `export *`.
	 */
	complete: boolean;
	/**
	 * True if `module.exports` is assigned a whole value (an object literal or
	 * otherwise), i.e. the default export is the assigned value rather than the
	 * initial `exports` object.
	 */
	reassignsModuleExports: boolean;
	/**
	 * Literal require specifiers whose exports this module re-exports: assigned to
	 * module.exports, spread into it, or copied by a compiler's star-export helper.
	 */
	reexports: Set<string>;
}

function isExportsIdentifier(node: ESTree.Node): boolean {
	return node.type === "Identifier" && node.name === "exports";
}

function isModuleExports(node: ESTree.Node): boolean {
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.object.type === "Identifier" &&
		node.object.name === "module" &&
		node.property.type === "Identifier" &&
		node.property.name === "exports"
	);
}

/** A non-computed member/property name (`exports.foo` / `{ foo: … }`), else null. */
function staticKey(node: ESTree.Node, computed: boolean): string | null {
	if (computed) {
		return null;
	}
	if (node.type === "Identifier") {
		return node.name;
	}
	if (node.type === "Literal" && typeof node.value === "string") {
		return node.value;
	}
	return null;
}

function literalRequireSpecifier(node: ESTree.Node): string | null {
	if (node.type !== "CallExpression") {
		return null;
	}
	const callee = node.callee as ESTree.Node;
	const argument = node.arguments[0] as ESTree.Node | undefined;
	if (
		callee.type !== "Identifier" ||
		callee.name !== "require" ||
		node.arguments.length !== 1 ||
		argument?.type !== "Literal" ||
		typeof argument.value !== "string"
	) {
		return null;
	}
	return argument.value;
}

/** `require("x")`, or one interop helper call around it such as `__importStar(require("x"))`. */
function wrappedRequireSpecifier(node: ESTree.Node): string | null {
	const direct = literalRequireSpecifier(node);
	if (direct !== null || node.type !== "CallExpression" || node.arguments.length !== 1) {
		return direct;
	}
	return literalRequireSpecifier(node.arguments[0] as ESTree.Node);
}

/** The helper name a call invokes: `f(…)`, `ns.f(…)` or the indirect `(0, ns.f)(…)`. */
function calleeName(node: ESTree.CallExpression): string | null {
	let callee = node.callee as ESTree.Node;
	if (callee.type === "SequenceExpression") {
		callee = callee.expressions.at(-1) as ESTree.Node;
	}
	if (callee.type === "Identifier") return callee.name;
	if (callee.type === "MemberExpression" && !callee.computed) {
		return callee.property.type === "Identifier" ? callee.property.name : null;
	}
	return null;
}

/**
 * The module a TypeScript star-export helper copies into `exports`:
 * `__exportStar(require("x"), exports)`, or `__export(require("x"))` from older
 * compilers. Node's CommonJS lexer recognizes the same calls.
 */
function starExportSpecifier(node: ESTree.CallExpression): string | null {
	const name = calleeName(node);
	const source = node.arguments[0] as ESTree.Node | undefined;
	if (source === undefined) return null;
	if (name === "__exportStar" && node.arguments.length === 2) {
		const target = node.arguments[1] as ESTree.Node;
		return isExportsIdentifier(target) || isModuleExports(target)
			? literalRequireSpecifier(source)
			: null;
	}
	return name === "__export" && node.arguments.length === 1
		? literalRequireSpecifier(source)
		: null;
}

/** The binding Babel's `Object.keys(_x).forEach(…)` star export iterates, if any. */
function babelStarExportBinding(node: ESTree.CallExpression): string | null {
	const callee = node.callee as ESTree.Node;
	if (
		callee.type !== "MemberExpression" ||
		callee.computed ||
		callee.property.type !== "Identifier" ||
		callee.property.name !== "forEach" ||
		callee.object.type !== "CallExpression"
	) {
		return null;
	}
	const keys = callee.object;
	const keysCallee = keys.callee as ESTree.Node;
	const source = keys.arguments[0] as ESTree.Node | undefined;
	return keysCallee.type === "MemberExpression" &&
		!keysCallee.computed &&
		keysCallee.object.type === "Identifier" &&
		keysCallee.object.name === "Object" &&
		keysCallee.property.type === "Identifier" &&
		keysCallee.property.name === "keys" &&
		keys.arguments.length === 1 &&
		source?.type === "Identifier"
		? source.name
		: null;
}

export function detectCjsExports(ast: ESTree.Program): CjsExportInfo {
	const names = new Set<string>();
	let complete = true;
	let reassignsModuleExports = false;
	const reexports = new Set<string>();

	const handleObjectLiteral = (object: ESTree.ObjectExpression) => {
		for (const property of object.properties) {
			if (property.type !== "Property" || property.computed) {
				// Spread, computed key, etc. — cannot enumerate fully.
				if (property.type === "SpreadElement") {
					const reexport = literalRequireSpecifier(property.argument);
					if (reexport !== null) reexports.add(reexport);
				}
				complete = false;
				continue;
			}
			const key = staticKey(property.key, false);
			if (key !== null) {
				names.add(key);
			} else {
				complete = false;
			}
		}
	};

	const handleAssignment = (node: ESTree.AssignmentExpression) => {
		if (node.operator !== "=") {
			return;
		}
		const left = node.left as ESTree.Node;

		if (left.type === "MemberExpression" && isModuleExports(left)) {
			// module.exports = <value>
			reassignsModuleExports = true;
			const right = node.right as ESTree.Node;
			if (right.type === "ObjectExpression") {
				handleObjectLiteral(right);
			} else {
				const reexport = literalRequireSpecifier(right);
				if (reexport !== null) {
					reexports.add(reexport);
				}
				// require(...), a function, a variable: names may come from a value
				// we cannot read statically.
				complete = false;
			}
			return;
		}

		if (left.type === "Identifier" && left.name === "exports") {
			// `exports = …` rebinds the wrapper parameter; it does not change
			// module.exports, so it adds no named exports.
			return;
		}

		if (
			left.type === "MemberExpression" &&
			(isExportsIdentifier(left.object) || isModuleExports(left.object))
		) {
			// exports.NAME = … / module.exports.NAME = …
			const key = staticKey(left.property, left.computed);
			if (key !== null) {
				names.add(key);
			} else {
				complete = false;
			}
		}
	};

	const handleDefineProperty = (node: ESTree.CallExpression) => {
		const callee = node.callee as ESTree.Node;
		if (
			callee.type !== "MemberExpression" ||
			callee.computed ||
			callee.object.type !== "Identifier" ||
			callee.object.name !== "Object" ||
			callee.property.type !== "Identifier" ||
			callee.property.name !== "defineProperty"
		) {
			return;
		}
		const target = node.arguments[0] as ESTree.Node | undefined;
		const key = node.arguments[1] as ESTree.Node | undefined;
		if (!target || !(isExportsIdentifier(target) || isModuleExports(target))) {
			return;
		}
		if (key && key.type === "Literal" && typeof key.value === "string") {
			names.add(key.value);
		} else {
			complete = false;
		}
	};

	// Bindings of required modules, which a Babel star export later iterates.
	const requiredBindings = new Map<string, string>();
	const handleStarExport = (node: ESTree.CallExpression) => {
		const binding = babelStarExportBinding(node);
		const reexport =
			binding === null
				? starExportSpecifier(node)
				: (requiredBindings.get(binding) ?? null);
		if (reexport !== null) {
			reexports.add(reexport);
			complete = false;
		}
	};

	traverseEstree(ast.body, (node) => {
		if (node.type === "AssignmentExpression") {
			handleAssignment(node);
		} else if (node.type === "CallExpression") {
			handleDefineProperty(node);
			handleStarExport(node);
		} else if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			node.init !== null &&
			node.init !== undefined
		) {
			const specifier = wrappedRequireSpecifier(node.init);
			if (specifier !== null) requiredBindings.set(node.id.name, specifier);
		}
	});
	return { names, complete, reassignsModuleExports, reexports };
}

/**
 * Whether a CommonJS module is pure data: its entire top level is `exports.x =`
 * / `module.exports.x =` / `module.exports =` assignments whose values are
 * side-effect-free (literals, function/arrow expressions, and object/array
 * literals of those). Such a module can be evaluated eagerly at program start
 * and its `require()` sites resolved to a direct slot read — no lazy wrapper
 * call — because there is nothing observable about *when* its body runs.
 *
 * Deliberately strict: anything that could have a side effect or reference
 * outside state (a call, a member read, a bare identifier, control flow) makes
 * it non-pure and it stays on the lazy registry.
 */
export function isPureDataCjsModule(ast: ESTree.Program): boolean {
	const isPureValue = (node: ESTree.Node): boolean => {
		switch (node.type) {
			case "Literal":
			case "FunctionExpression":
			case "ArrowFunctionExpression":
				return true;
			case "Identifier":
				return node.name === "undefined";
			case "UnaryExpression":
				return (
					["-", "+", "~", "!", "void"].includes(node.operator) &&
					isPureValue(node.argument)
				);
			case "ArrayExpression":
				return node.elements.every(
					(element) =>
						element === null ||
						(element.type !== "SpreadElement" && isPureValue(element)),
				);
			case "ObjectExpression":
				return node.properties.every(
					(property) =>
						property.type === "Property" &&
						!property.computed &&
						isPureValue(property.value as ESTree.Node),
				);
			default:
				return false;
		}
	};

	const isExportTarget = (node: ESTree.Node): boolean =>
		isModuleExports(node) ||
		(node.type === "MemberExpression" &&
			(isExportsIdentifier(node.object) || isModuleExports(node.object)));

	return ast.body.every((statement) => {
		if (statement.type !== "ExpressionStatement") {
			return false;
		}
		const expression = statement.expression;
		return (
			expression.type === "AssignmentExpression" &&
			expression.operator === "=" &&
			isExportTarget(expression.left) &&
			isPureValue(expression.right)
		);
	});
}
