import { readsGlobal, staticPropertyName, stripTypeSyntax } from "./syntax.ts";
import type { AnyNode, AstNode, Context, Rule } from "./types.ts";

// The names in `primordialGlobalBindings` in `src/compiler/shared/builtin-registry.ts`,
// copied because the plugin loads without the compiler. The rule's tests derive
// their cases from that list.
const PRIMORDIAL_GLOBALS = new Set([
	"globalThis",
	"Object",
	"Function",
	"Array",
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"SuppressedError",
	"DisposableStack",
	"AsyncDisposableStack",
	"String",
	"Number",
	"Boolean",
	"Symbol",
	"BigInt",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"FinalizationRegistry",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"DataView",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"Math",
	"JSON",
	"Atomics",
	"Reflect",
	"Proxy",
	"Promise",
	"Date",
	"Iterator",
	"AsyncIterator",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"unescape",
	"NaN",
	"Infinity",
	"undefined",
	"eval",
	"RegExp",
	"Temporal",
	"Intl",
	"ShadowRealm",
]);
const PRIMITIVE_GLOBALS = new Set(["NaN", "Infinity", "undefined"]);
// Node's stack trace hooks: the runtime gives them setters that accept assignment.
const ERROR_HOOKS = new Set(["Error.prepareStackTrace", "Error.stackTraceLimit"]);
const REFLECTED_MUTATORS = new Set([
	"Object.assign",
	"Object.defineProperty",
	"Object.defineProperties",
	"Object.setPrototypeOf",
	"Reflect.defineProperty",
	"Reflect.deleteProperty",
	"Reflect.set",
	"Reflect.setPrototypeOf",
]);
// The reflected mutators that name a global binding through their second argument.
const GLOBAL_KEY_MUTATORS = new Set([
	"Object.defineProperty",
	"Reflect.defineProperty",
	"Reflect.set",
	"Reflect.deleteProperty",
]);
const MUTATING_METHODS = new Set([
	"Array.prototype.copyWithin",
	"Array.prototype.fill",
	"Array.prototype.pop",
	"Array.prototype.push",
	"Array.prototype.reverse",
	"Array.prototype.shift",
	"Array.prototype.sort",
	"Array.prototype.splice",
	"Array.prototype.unshift",
	"Object.prototype.__defineGetter__",
	"Object.prototype.__defineSetter__",
]);

/**
 * A path from a primordial global, such as `Array.prototype`. An object's
 * properties are locked; a binding, such as `NaN` or `globalThis`, has none
 * worth following.
 */
interface Primordial {
	display: string;
	kind: "binding" | "object";
}

/**
 * The primordial global `node` reads. Like the compiler, only an undeclared name
 * counts: a top-level `var` is a module or CommonJS wrapper local in every file
 * the CLI compiles, even where Oxlint scopes the file as a classic script.
 */
function globalName(context: Context, node: AnyNode): string | undefined {
	return node.type === "Identifier" &&
		PRIMORDIAL_GLOBALS.has(node.name) &&
		readsGlobal(context, node)
		? node.name
		: undefined;
}

/**
 * The primordial path `node` reads, mirroring `primordialReference` in the
 * compiler. Its display is also what the compiler's `mutationTarget` and
 * `callPath` produce for every target and callee they can report.
 */
function primordial(context: Context, node: AnyNode): Primordial | undefined {
	const expression = stripTypeSyntax(node);
	const name = globalName(context, expression);
	if (name !== undefined) {
		return {
			display: name,
			kind: name === "globalThis" || PRIMITIVE_GLOBALS.has(name) ? "binding" : "object",
		};
	}
	if (expression.type !== "MemberExpression") return undefined;
	const property = staticPropertyName(expression);
	const object =
		property === undefined ? undefined : primordial(context, expression.object);
	if (property === undefined || object === undefined) return undefined;
	if (object.display === "globalThis") {
		return PRIMORDIAL_GLOBALS.has(property)
			? {
					display: `globalThis.${property}`,
					kind: PRIMITIVE_GLOBALS.has(property) ? "binding" : "object",
				}
			: undefined;
	}
	return object.kind === "object"
		? { display: `${object.display}.${property}`, kind: "object" }
		: undefined;
}

/** The locked target a reflected mutator's arguments name. */
function reflectedTarget(
	context: Context,
	call: AstNode<"CallExpression">,
	path: string,
): string | undefined {
	const [argument, key] = call.arguments;
	if (argument === undefined || argument.type === "SpreadElement") return undefined;
	const target = primordial(context, argument);
	if (target?.kind === "object") return target.display;
	if (
		target?.display !== "globalThis" ||
		!GLOBAL_KEY_MUTATORS.has(path) ||
		key === undefined ||
		key.type === "SpreadElement"
	)
		return undefined;
	const name = stripTypeSyntax(key);
	return name.type === "Literal" &&
		typeof name.value === "string" &&
		PRIMORDIAL_GLOBALS.has(name.value)
		? `globalThis.${name.value}`
		: undefined;
}

/**
 * The default build locks built-ins (`engine.primordials: "locked"`), so a write
 * to one throws "Cannot assign locked primordial property" at run time, while the
 * build only warns. This rule reports what that build warning reports, from
 * `src/compiler/frontend/primordial-diagnostics.ts`: assignments, deletes,
 * reflected definitions and in-place array methods on a primordial global or
 * a path from it. Oxlint's `no-extend-native` covers `X.prototype` writes only.
 */
export const noPrimordialMutation: Rule = {
	meta: {
		type: "problem",
		docs: {
			description: "Disallow changing built-in objects, which the default build locks",
		},
		messages: {
			locked:
				"`{{target}}` is locked in the default build, so this {{operation}} throws a TypeError. Export your own value from a module or wrap the built-in in a function.",
		},
	},
	createOnce(context) {
		function report(node: AnyNode, target: string, operation: string): void {
			context.report({ node, messageId: "locked", data: { target, operation } });
		}
		function reportAssignment(node: AnyNode, left: AnyNode): void {
			const target = primordial(context, left)?.display;
			if (target !== undefined && !ERROR_HOOKS.has(target))
				report(node, target, "assignment");
		}
		return {
			AssignmentExpression(assignment) {
				reportAssignment(assignment, assignment.left);
			},
			UpdateExpression(update) {
				reportAssignment(update, update.argument);
			},
			UnaryExpression(unary) {
				if (unary.operator !== "delete") return;
				const target = primordial(context, unary.argument)?.display;
				if (target !== undefined) report(unary, target, "delete");
			},
			CallExpression(call) {
				const callee = stripTypeSyntax(call.callee);
				const path = primordial(context, callee)?.display;
				if (path === undefined) return;
				if (REFLECTED_MUTATORS.has(path)) {
					const target = reflectedTarget(context, call, path);
					if (target !== undefined) report(call, target, `\`${path}\` call`);
				} else if (MUTATING_METHODS.has(path) && callee.type === "MemberExpression") {
					const target = primordial(context, callee.object);
					if (target?.kind === "object") report(call, target.display, `\`${path}\` call`);
				}
			},
		};
	},
};
