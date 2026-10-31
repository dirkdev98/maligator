import type { ESTree } from "meriyah";
import { BuildConfigError } from "./build-config-error.ts";
import {
	defineBuild as defineBuildIdentity,
	defineLibrary as defineLibraryIdentity,
} from "./build.ts";
import { parseModule } from "./compiler/frontend/parser.ts";

/**
 * A schema node: the allowed keys at this level and, per key, either a leaf value
 * validator or a nested object schema. Any key not listed is a hard error — the
 * whole point of a definition is to be small and understandable, so a typo should
 * fail loudly rather than be silently ignored.
 */
export type Leaf = { leaf: (value: unknown, at: string) => void };
export type ObjectSchema = { object: Record<string, Leaf | ObjectSchema> };
type SchemaNode = Leaf | ObjectSchema;

/** A schema violation; `validateDefinition` prefixes it with the definition's label. */
export class SchemaViolation extends Error {}

function isObjectSchema(node: SchemaNode): node is ObjectSchema {
	return "object" in node;
}

export function expect(condition: boolean, at: string, expected: string): void {
	if (!condition) {
		throw new SchemaViolation(`'${at}' must be ${expected}`);
	}
}

export function expectObject(
	value: unknown,
	at: string,
): asserts value is Record<string, unknown> {
	expect(
		typeof value === "object" && value !== null && !Array.isArray(value),
		at,
		"an object",
	);
}

/** Reject keys outside `allowed`, naming the full path of the first offender. */
export function expectKeys(
	value: Record<string, unknown>,
	at: string,
	allowed: ReadonlyArray<string>,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new SchemaViolation(
				`unknown key '${at === "" ? key : `${at}.${key}`}' (allowed: ${allowed.join(", ")})`,
			);
		}
	}
}

export const booleanLeaf: Leaf = {
	leaf: (value, at) => expect(typeof value === "boolean", at, "a boolean"),
};
export const stringLeaf: Leaf = {
	leaf: (value, at) => expect(typeof value === "string", at, "a string"),
};
export const stringArrayLeaf: Leaf = {
	leaf: (value, at) =>
		expect(
			Array.isArray(value) && value.every((item) => typeof item === "string"),
			at,
			"an array of strings",
		),
};
export const stringRecordLeaf: Leaf = {
	leaf: (value, at) =>
		expect(
			typeof value === "object" &&
				value !== null &&
				!Array.isArray(value) &&
				Object.entries(value).every(
					([key, entry]) =>
						key.length > 0 && typeof entry === "string" && entry.length > 0,
				),
			at,
			"a record of non-empty string replacements",
		),
};

function validate(value: unknown, schema: SchemaNode, at: string): void {
	if (isObjectSchema(schema)) {
		expectObject(value, at);
		expectKeys(value, at, Object.keys(schema.object));
		for (const [key, child] of Object.entries(value)) {
			validate(child, schema.object[key]!, at === "" ? key : `${at}.${key}`);
		}
	} else {
		schema.leaf(value, at);
	}
}

/** Validate `value` against `schema`, rejecting unknown keys and wrong types. */
export function validateDefinition(
	value: unknown,
	schema: ObjectSchema,
	label: string,
): void {
	try {
		validate(value, schema, "");
	} catch (error) {
		if (error instanceof SchemaViolation) {
			throw new BuildConfigError(`${label}: ${error.message}`);
		}
		throw error;
	}
}

export type BuildConfigTypeStripper = (source: string, filePath: string) => string;

/** The kind of trusted definition module, which fixes its one importable helper. */
export interface DefinitionKind {
	/** Diagnostic prefix, such as `maligator.build.ts`. */
	readonly label: string;
	readonly helper: "defineBuild" | "defineLibrary";
	/** What the default export holds, for diagnostics. */
	readonly noun: string;
}

function sourceOffset(
	source: string,
	location: { line: number; column: number },
): number {
	let line = 1;
	let offset = 0;
	while (line < location.line) {
		const newline = source.indexOf("\n", offset);
		if (newline < 0) {
			return source.length;
		}
		offset = newline + 1;
		line++;
	}
	return offset + location.column;
}

function overwritePreservingLines(
	output: Array<string>,
	start: number,
	end: number,
	label: string,
	replacement = "",
): void {
	let replacementIndex = 0;
	for (let index = start; index < end; index++) {
		if (output[index] === "\n" || output[index] === "\r") {
			continue;
		}
		output[index] = replacement[replacementIndex++] ?? " ";
	}
	if (replacementIndex < replacement.length) {
		throw new BuildConfigError(`${label}: unsupported default export layout`);
	}
}

function statementRange(
	source: string,
	statement: ESTree.Node,
	label: string,
): { start: number; end: number } {
	if (statement.loc === undefined || statement.loc === null) {
		throw new BuildConfigError(`${label}: parser omitted source locations`);
	}
	return {
		start: sourceOffset(source, statement.loc.start),
		end: sourceOffset(source, statement.loc.end),
	};
}

/**
 * The value of a definition expression built only from literals, or undefined
 * when evaluating it could run code or depend on bindings.
 */
function definitionData(
	node: ESTree.Node,
	helper: string,
): { value: unknown } | undefined {
	switch (node.type) {
		case "Literal":
			return node.value === null ||
				typeof node.value === "string" ||
				typeof node.value === "number" ||
				typeof node.value === "boolean"
				? { value: node.value }
				: undefined;
		case "TemplateLiteral":
			return node.expressions.length === 0 && node.quasis[0]?.value.cooked !== undefined
				? { value: node.quasis[0].value.cooked }
				: undefined;
		case "UnaryExpression":
			return node.operator === "-" &&
				node.argument.type === "Literal" &&
				typeof node.argument.value === "number"
				? { value: -node.argument.value }
				: undefined;
		case "ArrayExpression": {
			const value: Array<unknown> = [];
			for (const element of node.elements) {
				const item = element === null ? undefined : definitionData(element, helper);
				if (item === undefined) return undefined;
				value.push(item.value);
			}
			return { value };
		}
		case "ObjectExpression": {
			const value: Record<string, unknown> = {};
			for (const property of node.properties) {
				if (
					property.type !== "Property" ||
					property.kind !== "init" ||
					property.computed ||
					property.method ||
					property.shorthand
				)
					return undefined;
				const key =
					property.key.type === "Identifier"
						? property.key.name
						: property.key.type === "Literal" &&
							  (typeof property.key.value === "string" ||
									typeof property.key.value === "number")
							? String(property.key.value)
							: undefined;
				// `__proto__: value` sets the prototype rather than defining a property.
				if (key === undefined || key === "__proto__") return undefined;
				const item = definitionData(property.value, helper);
				if (item === undefined) return undefined;
				value[key] = item.value;
			}
			return { value };
		}
		case "CallExpression": {
			// meriyah types CallExpression.callee as `any`.
			const callee = node.callee as ESTree.Node;
			return callee.type === "Identifier" &&
				callee.name === helper &&
				node.arguments.length === 1 &&
				node.arguments[0]!.type !== "SpreadElement"
				? definitionData(node.arguments[0]!, helper)
				: undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Evaluate a trusted TypeScript definition module, such as `maligator.build.ts`,
 * and return its default export. Plain-data exports are read without running code.
 */
export function evaluateDefinitionModule(
	source: string,
	filePath: string,
	kind: DefinitionKind,
	stripTypes: BuildConfigTypeStripper,
): unknown {
	const { label, helper, noun } = kind;
	let stripped: string;
	let ast: ESTree.Program;
	try {
		stripped = stripTypes(source, filePath);
		ast = parseModule(stripped).ast;
	} catch (error) {
		throw new BuildConfigError(
			`${label}: cannot parse ${filePath}: ${(error as Error).message}`,
		);
	}

	if (stripped.includes("$cfg")) {
		throw new BuildConfigError(
			`${label}: '$cfg' is reserved by the configuration loader`,
		);
	}

	const output = stripped.split("");
	let defaultExport: ESTree.ExportDefaultDeclaration | undefined;
	for (const statement of ast.body) {
		if (statement.type === "ImportDeclaration") {
			const validImport =
				(statement.source.value === "@maligator/cli" ||
					statement.source.value === "maligator") &&
				statement.specifiers.length === 1 &&
				statement.specifiers[0]?.type === "ImportSpecifier" &&
				statement.specifiers[0].imported.type === "Identifier" &&
				statement.specifiers[0].imported.name === helper &&
				statement.specifiers[0].local.name === helper;
			if (!validImport) {
				throw new BuildConfigError(
					`${label}: only \`import { ${helper} } from "@maligator/cli"\` is supported`,
				);
			}
			const range = statementRange(stripped, statement, label);
			overwritePreservingLines(output, range.start, range.end, label);
			continue;
		}
		if (statement.type === "ExportDefaultDeclaration") {
			if (defaultExport !== undefined) {
				throw new BuildConfigError(`${label}: multiple default exports`);
			}
			if (
				statement.declaration.type === "FunctionDeclaration" ||
				statement.declaration.type === "ClassDeclaration"
			) {
				throw new BuildConfigError(
					`${label}: the default export must be a ${noun} value`,
				);
			}
			defaultExport = statement;
			const exportRange = statementRange(stripped, statement, label);
			const declarationRange = statementRange(stripped, statement.declaration, label);
			overwritePreservingLines(
				output,
				exportRange.start,
				declarationRange.start,
				label,
				"$cfg=",
			);
			continue;
		}
		if (statement.type.startsWith("Export")) {
			throw new BuildConfigError(`${label}: only a default ${noun} export is supported`);
		}
	}

	if (defaultExport === undefined) {
		throw new BuildConfigError(`${label}: missing default export`);
	}
	// Starting the CLI's eval compiler dominates a command whose definition is plain data.
	if (
		ast.body.every(
			(statement) =>
				statement.type === "ImportDeclaration" || statement === defaultExport,
		)
	) {
		const data = definitionData(defaultExport.declaration, helper);
		if (data !== undefined) return data.value;
	}

	let $cfg: unknown;
	// Both helpers are identity functions; the import check above admits only one.
	const defineBuild = defineBuildIdentity;
	const defineLibrary = defineLibraryIdentity;
	void defineBuild;
	void defineLibrary;
	try {
		// Direct eval gives trusted project definitions ordinary JS control flow and
		// access to the CLI's host globals without a compile/link subprocess.
		eval(`${output.join("")}\n//# sourceURL=${filePath}`);
	} catch (error) {
		const detail = (error as Error).stack ?? (error as Error).message;
		throw new BuildConfigError(`${label}: evaluation failed in ${filePath}:\n${detail}`);
	}
	return $cfg;
}
