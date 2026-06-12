import type { ESTree } from "meriyah";

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

export function detectCjsExports(ast: ESTree.Program): CjsExportInfo {
	const names = new Set<string>();
	let complete = true;
	let reassignsModuleExports = false;

	const handleObjectLiteral = (object: ESTree.ObjectExpression) => {
		for (const property of object.properties) {
			if (property.type !== "Property" || property.computed) {
				// Spread, computed key, etc. — cannot enumerate fully.
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
				// require(...), a function, a variable: names come from a value we
				// cannot read statically.
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

	const visit = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item);
			}
			return;
		}
		if (!value || typeof value !== "object" || !("type" in value)) {
			return;
		}
		const node = value as ESTree.Node;

		if (node.type === "AssignmentExpression") {
			handleAssignment(node);
		} else if (node.type === "CallExpression") {
			handleDefineProperty(node);
		}

		for (const key of Object.keys(node)) {
			visit((node as unknown as Record<string, unknown>)[key]);
		}
	};

	visit(ast.body);
	return { names, complete, reassignsModuleExports };
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
