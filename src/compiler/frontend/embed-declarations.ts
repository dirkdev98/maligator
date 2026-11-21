import { parse as meriyahParse } from "meriyah";
import type { ESTree } from "meriyah";
import { traverseEstree } from "./estree-traversal.ts";
import { bindingAt } from "./worker-entries.ts";

/**
 * `maligator:assets` declarations become imports the module graph resolves like any
 * other: the transform below replaces each literal `embedFile`/`embedDirectory` call
 * with a binding imported from an embed request. Resolution turns the request into a
 * host module whose installer builds the handle, so a declaration the program can no
 * longer reach after optimization leaves its installer slot, and its files, unused.
 */
export const EMBED_SOURCE_MODULE = "maligator:assets";
export const EMBED_INSTALLER = "mal_host_install_maligator_assets";
const EMBED_REQUEST_PREFIX = "maligator:embed?";
const EMBED_MODULE_PREFIX = "maligator:embed:";

/** What a call declares, before its specifier is resolved. */
export interface EmbedRequest {
	readonly kind: "file" | "directory";
	readonly specifier: string;
	readonly include?: ReadonlyArray<string>;
	readonly exclude?: ReadonlyArray<string>;
	readonly dot?: true;
}

/**
 * A resolved declaration. Its canonical JSON is the host module identity, the
 * installer's slot data and the name of the embedded copy in a built executable.
 */
export interface EmbedDeclaration {
	readonly kind: "file" | "directory";
	/** Absolute path of the file or directory. */
	readonly path: string;
	readonly include?: ReadonlyArray<string>;
	readonly exclude?: ReadonlyArray<string>;
	readonly dot?: true;
}

export class EmbedDeclarationError extends SyntaxError {}

export function isEmbedRequest(specifier: string): boolean {
	return specifier.startsWith(EMBED_REQUEST_PREFIX);
}

export function isEmbedModule(id: string): boolean {
	return id.startsWith(EMBED_MODULE_PREFIX);
}

export function parseEmbedRequest(specifier: string): EmbedRequest {
	return JSON.parse(specifier.slice(EMBED_REQUEST_PREFIX.length)) as EmbedRequest;
}

/** Key order is fixed so equal declarations share one identity. */
export function canonicalEmbedDeclaration(
	request: EmbedRequest,
	resolvedPath: string,
): EmbedDeclaration {
	return {
		kind: request.kind,
		path: resolvedPath,
		...(request.include === undefined ? {} : { include: [...request.include] }),
		...(request.exclude === undefined ? {} : { exclude: [...request.exclude] }),
		...(request.dot === true ? { dot: true as const } : {}),
	};
}

export function embedModuleId(declaration: EmbedDeclaration): string {
	return EMBED_MODULE_PREFIX + JSON.stringify(declaration);
}

export function embedModuleDeclaration(id: string): EmbedDeclaration {
	return JSON.parse(id.slice(EMBED_MODULE_PREFIX.length)) as EmbedDeclaration;
}

/**
 * Reject a pattern the collector and the runtime could interpret differently: one
 * that escapes the directory, names an empty segment or uses another separator.
 */
export function embedPatternError(pattern: string): string | undefined {
	if (
		pattern.length === 0 ||
		pattern.includes("\\") ||
		pattern.includes("\0") ||
		pattern.startsWith("/")
	)
		return `invalid pattern '${pattern}'`;
	return pattern
		.split("/")
		.some((segment) => segment === "" || segment === "." || segment === "..")
		? `invalid pattern '${pattern}'`
		: undefined;
}

interface Replacement {
	readonly start: number;
	readonly end: number;
	readonly request: EmbedRequest;
}

/** Parsed with `ranges` and `loc`, so every node carries both. */
type Located = {
	readonly start?: number;
	readonly end?: number;
	readonly loc?: {
		readonly start: { readonly line: number; readonly column: number };
	} | null;
};

/**
 * Replace each `maligator:assets` declaration call in an ES module with an imported
 * handle. Lines and the columns before each call are preserved, so diagnostics and
 * profile sites keep pointing at the source the author wrote.
 */
export function transformEmbedDeclarations(source: string, filePath: string): string {
	if (!source.includes(EMBED_SOURCE_MODULE)) return source;
	let ast: ESTree.Program;
	try {
		ast = meriyahParse(source, {
			sourceType: "module",
			next: true,
			loc: true,
			ranges: true,
			impliedStrict: true,
		});
	} catch {
		// The ordinary parse reports the syntax error with its usual diagnostics.
		return source;
	}
	const fail = (node: Located, message: string): never => {
		const position =
			node.loc === undefined || node.loc === null
				? ""
				: `:${node.loc.start.line}:${node.loc.start.column + 1}`;
		throw new EmbedDeclarationError(`${filePath}${position}: ${message}`);
	};

	const named = new Map<string, "embedFile" | "embedDirectory">();
	const namespaces = new Set<string>();
	const bindings = new Set<ESTree.Node>();
	for (const statement of ast.body) {
		if (
			(statement.type === "ExportNamedDeclaration" ||
				statement.type === "ExportAllDeclaration") &&
			statement.source?.value === EMBED_SOURCE_MODULE
		)
			fail(
				statement,
				`re-exporting ${EMBED_SOURCE_MODULE} hides its declarations from the build; import it where you call it`,
			);
		if (
			statement.type !== "ImportDeclaration" ||
			statement.source.value !== EMBED_SOURCE_MODULE
		)
			continue;
		for (const specifier of statement.specifiers) {
			if (specifier.type === "ImportNamespaceSpecifier") {
				namespaces.add(specifier.local.name);
			} else if (specifier.type === "ImportSpecifier") {
				const imported =
					specifier.imported.type === "Identifier"
						? specifier.imported.name
						: String(specifier.imported.value);
				if (imported !== "embedFile" && imported !== "embedDirectory") continue;
				named.set(specifier.local.name, imported);
			} else continue;
			bindings.add(specifier);
		}
	}

	const scope = { parsed: { type: "module" as const, strict: true, ast } };
	const parents = new Map<ESTree.Node, ESTree.Node>();
	const references: Array<{ node: ESTree.Identifier; key: string | number | null }> = [];
	traverseEstree(ast, (node, { parent, key }) => {
		if (parent !== null) parents.set(node, parent);
		if (
			node.type === "ImportExpression" &&
			node.source.type === "Literal" &&
			node.source.value === EMBED_SOURCE_MODULE
		)
			fail(node, `import ${EMBED_SOURCE_MODULE} statically so the build sees its calls`);
		if (
			node.type === "Identifier" &&
			parent !== null &&
			(named.has(node.name) || namespaces.has(node.name)) &&
			isReference(parent, key)
		)
			references.push({ node, key });
	});

	const replacements: Array<Replacement> = [];
	for (const { node, key } of references) {
		const binding = bindingAt(scope, node, node.name);
		if (binding === undefined || !bindings.has(binding)) continue;
		const parent = parents.get(node)!;
		let kind = named.get(node.name);
		let callee: ESTree.Node = node;
		if (kind === undefined && parent.type === "MemberExpression" && key === "object") {
			const member = memberName(parent);
			if (member === "embedFile" || member === "embedDirectory") {
				kind = member;
				callee = parent;
			}
		}
		const call = parents.get(callee);
		if (
			kind === undefined ||
			call?.type !== "CallExpression" ||
			call.callee !== callee ||
			(callee.type === "MemberExpression" && callee.optional)
		)
			fail(
				node,
				`${kind ?? node.name} from ${EMBED_SOURCE_MODULE} can only be called directly, with literal arguments`,
			);
		replacements.push(declaration(call as ESTree.CallExpression, kind!, fail));
	}
	if (replacements.length === 0) return source;

	replacements.sort((left, right) => left.start - right.start);
	let prefix = "$_e";
	while (source.includes(prefix)) prefix += "_";
	const imports: Array<string> = [];
	let output = "";
	let cursor = 0;
	replacements.forEach((replacement, index) => {
		const local = `${prefix}${index}`;
		output += source.slice(cursor, replacement.start);
		output += overwrite(source.slice(replacement.start, replacement.end), local);
		cursor = replacement.end;
		imports.push(
			`import ${local} from ${JSON.stringify(EMBED_REQUEST_PREFIX + JSON.stringify(replacement.request))};`,
		);
	});
	return `${output}${source.slice(cursor)}\n;${imports.join("")}\n`;
}

function memberName(node: ESTree.MemberExpression): string | undefined {
	if (!node.computed && node.property.type === "Identifier") return node.property.name;
	if (node.computed && node.property.type === "Literal")
		return String(node.property.value);
	return undefined;
}

/** Whether an identifier reads a binding, rather than naming a key, label or declaration. */
function isReference(parent: ESTree.Node, key: string | number | null): boolean {
	switch (parent.type) {
		case "MemberExpression":
			return key === "object" || parent.computed;
		case "Property":
			return key === "value" || (key === "key" && parent.computed);
		case "MethodDefinition":
		case "PropertyDefinition":
		case "AccessorProperty":
			return key !== "key" || parent.computed;
		case "ImportSpecifier":
		case "ImportDefaultSpecifier":
		case "ImportNamespaceSpecifier":
		case "LabeledStatement":
		case "BreakStatement":
		case "ContinueStatement":
		case "MetaProperty":
			return false;
		case "ExportSpecifier":
			return key === "local";
		case "VariableDeclarator":
			return key === "init";
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ClassDeclaration":
		case "ClassExpression":
		case "CatchClause":
			return false;
		default:
			return true;
	}
}

/** Keep every line break of the call so the lines after it stay where they were. */
function overwrite(text: string, local: string): string {
	const blank = text.replace(/[^\r\n\u2028\u2029]/g, " ");
	const firstBreak = blank.search(/[\r\n\u2028\u2029]/);
	const firstLine = firstBreak < 0 ? blank.length : firstBreak;
	return local + blank.slice(Math.min(local.length, firstLine));
}

function declaration(
	call: ESTree.CallExpression,
	kind: "embedFile" | "embedDirectory",
	fail: (node: Located, message: string) => never,
): Replacement {
	const node = call as Located;
	if (call.optional) fail(node, `${kind} cannot be called optionally`);
	const [specifierNode, optionsNode, ...rest] = call.arguments;
	if (rest.length > 0 || (kind === "embedFile" && optionsNode !== undefined))
		fail(
			node,
			`${kind} takes ${kind === "embedFile" ? "one argument" : "at most two arguments"}`,
		);
	const specifier = literalString(specifierNode);
	if (specifier === undefined)
		fail(node, `${kind} needs a string literal specifier, resolved like an import`);
	if (specifier.length === 0) fail(node, `${kind} needs a non-empty specifier`);
	let request: EmbedRequest = {
		kind: kind === "embedFile" ? "file" : "directory",
		specifier,
	};
	if (optionsNode !== undefined) {
		const options = literalOptions(optionsNode, kind, fail);
		request = { ...request, ...options };
	}
	return { start: node.start!, end: node.end!, request };
}

function literalString(node: ESTree.Node | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
		return node.quasis[0]?.value.cooked ?? undefined;
	return undefined;
}

function literalOptions(
	node: ESTree.Node,
	kind: string,
	fail: (node: Located, message: string) => never,
): Pick<EmbedRequest, "include" | "exclude" | "dot"> {
	if (node.type !== "ObjectExpression")
		fail(node, `${kind} options must be an object literal`);
	const options: { include?: Array<string>; exclude?: Array<string>; dot?: true } = {};
	for (const property of node.properties) {
		if (
			property.type !== "Property" ||
			property.kind !== "init" ||
			property.computed ||
			property.method ||
			property.shorthand
		)
			fail(property, `${kind} options must be plain literal properties`);
		const entry = property;
		const name =
			entry.key.type === "Identifier"
				? entry.key.name
				: entry.key.type === "Literal"
					? String(entry.key.value)
					: undefined;
		if (name === "include" || name === "exclude") {
			const patterns = literalStrings(entry.value);
			if (patterns === undefined)
				fail(entry.value, `${kind} option '${name}' must be an array of string literals`);
			if (name === "include" && patterns.length === 0)
				fail(entry.value, `${kind} option 'include' needs at least one pattern`);
			for (const pattern of patterns) {
				const error = embedPatternError(pattern);
				if (error !== undefined) fail(entry.value, `${kind} option '${name}': ${error}`);
			}
			if (name === "exclude" && patterns.length === 0) continue;
			options[name] = patterns;
		} else if (name === "dot") {
			if (entry.value.type !== "Literal" || typeof entry.value.value !== "boolean")
				fail(entry.value, `${kind} option 'dot' must be a boolean literal`);
			if (entry.value.value === true) options.dot = true;
		} else {
			fail(entry, `unknown ${kind} option '${name}' (allowed: include, exclude, dot)`);
		}
	}
	return options;
}

function literalStrings(node: ESTree.Node): Array<string> | undefined {
	if (node.type !== "ArrayExpression") return undefined;
	const values: Array<string> = [];
	for (const element of node.elements) {
		const value = literalString(element ?? undefined);
		if (value === undefined) return undefined;
		values.push(value);
	}
	return values;
}
