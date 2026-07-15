import type { ESTree } from "meriyah";
import { parseScript } from "../parser.ts";
import type { Test262File } from "./types.ts";

export const TEST262_SHARED_INCLUDE_NAMES = new Set([
	"propertyHelper.js",
	"testTypedArray.js",
	"testIntl.js",
]);

export interface Test262SharedHelper {
	id: string;
	path: string;
	source: string;
	parsed: ReturnType<typeof parseScript>;
}

export interface Test262SharedSourcePlan {
	kind: "shared";
	helpers: Array<Test262SharedHelper>;
	testSource: string;
	parsedTest: ReturnType<typeof parseScript>;
}

export interface Test262LegacySourcePlan {
	kind: "legacy";
	reason: string;
}

export type Test262SourcePlan = Test262SharedSourcePlan | Test262LegacySourcePlan;

const PARSED_HELPER_CACHE = new Map<string, ReturnType<typeof parseScript> | undefined>();

function hasTopLevelLexicalDeclaration(program: ESTree.Program): boolean {
	return program.body.some(
		(statement) =>
			statement.type === "ClassDeclaration" ||
			(statement.type === "VariableDeclaration" && statement.kind !== "var"),
	);
}

function addBindingNames(node: ESTree.Node, names: Set<string>): void {
	if (node.type === "Identifier") {
		names.add(node.name);
		return;
	}
	if (node.type === "RestElement") {
		addBindingNames(node.argument, names);
		return;
	}
	if (node.type === "AssignmentPattern") {
		addBindingNames(node.left, names);
		return;
	}
	if (node.type === "ArrayPattern") {
		for (const element of node.elements) {
			if (element !== null) addBindingNames(element, names);
		}
		return;
	}
	if (node.type === "ObjectPattern") {
		for (const property of node.properties) {
			if (property.type === "Property") {
				addBindingNames(property.value, names);
			} else if (property.type === "RestElement" || property.type === "SpreadElement") {
				addBindingNames(property.argument, names);
			}
		}
	}
}

function scriptVarDeclaredNames(program: ESTree.Program): Set<string> {
	const names = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const node = value as ESTree.Node;
		if (node.type === "FunctionDeclaration") {
			if (node.id !== null) names.add(node.id.name);
			return;
		}
		if (node.type === "ClassDeclaration") return;
		if (
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression" ||
			node.type === "ClassExpression"
		) {
			return;
		}
		if (node.type === "VariableDeclaration") {
			if (node.kind === "var") {
				for (const declaration of node.declarations) {
					addBindingNames(declaration.id, names);
				}
			}
			return;
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(program.body);
	return names;
}

/**
 * Plan the conservative helper-sharing subset. Prefixing later source fragments
 * with an empty statement preserves the composed harness's directive-prologue
 * boundaries when each fragment is compiled independently.
 */
export function planTest262SharedHelpers(
	file: Test262File,
	strict: boolean,
	loadHarness: (name: string) => string,
): Test262SourcePlan {
	const flags = file.frontmatter.flags ?? [];
	if (flags.includes("module") || flags.includes("raw")) {
		return { kind: "legacy", reason: "module-or-raw" };
	}
	if (flags.includes("async") || file.frontmatter.features?.includes("dynamic-import")) {
		return { kind: "legacy", reason: "async-or-dynamic-import" };
	}
	if (file.frontmatter.negative !== undefined) {
		return { kind: "legacy", reason: "negative" };
	}

	const includes = file.frontmatter.includes ?? [];
	if (includes.some((name) => !TEST262_SHARED_INCLUDE_NAMES.has(name))) {
		return { kind: "legacy", reason: "unsupported-include" };
	}

	try {
		const helperNames = ["assert.js", "sta.js", ...includes];
		const helpers = helperNames.map((name, index): Test262SharedHelper => {
			const source = `${index === 0 ? "" : ";"}${loadHarness(name)}`;
			const cacheKey = `${strict ? "strict" : "sloppy"}\0${name}\0${source}`;
			let parsed = PARSED_HELPER_CACHE.get(cacheKey);
			if (!PARSED_HELPER_CACHE.has(cacheKey)) {
				const candidate = parseScript(source, { strict });
				parsed = hasTopLevelLexicalDeclaration(candidate.ast) ? undefined : candidate;
				PARSED_HELPER_CACHE.set(cacheKey, parsed);
			}
			if (parsed === undefined) {
				throw new Error(`top-level lexical declaration in ${name}`);
			}
			return {
				id: `${index < 2 ? "standard:" : "include:"}${name}`,
				path: `harness/${name}`,
				source,
				parsed,
			};
		});

		const testSource = `;${file.content}`;
		const parsedTest = parseScript(testSource, { strict });
		if (hasTopLevelLexicalDeclaration(parsedTest.ast)) {
			return { kind: "legacy", reason: "test-top-level-lexical" };
		}
		if (scriptVarDeclaredNames(parsedTest.ast).size > 0) {
			// Whole-script declaration instantiation runs before any harness code in
			// legacy composition. Separate helper entries cannot preserve that ordering.
			return { kind: "legacy", reason: "test-var-or-function-declaration" };
		}
		const occupiedNames = new Set<string>();
		for (const helper of helpers) {
			for (const name of scriptVarDeclaredNames(helper.parsed.ast)) {
				if (occupiedNames.has(name)) {
					return { kind: "legacy", reason: "helper-declaration-collision" };
				}
				occupiedNames.add(name);
			}
		}

		return { kind: "shared", helpers, testSource, parsedTest };
	} catch {
		// Invalid syntax and unsupported helper syntax must retain the exact legacy
		// compile/error path; the compiler decides negative and failure verdicts.
		return { kind: "legacy", reason: "parse-or-helper-ineligible" };
	}
}

export function test262SourcePlanCacheInput(
	plan: Test262SourcePlan,
	composedSource: string,
): string {
	if (plan.kind === "legacy") {
		return `legacy:${plan.reason}\n${composedSource}`;
	}
	return `shared:${plan.helpers.map((helper) => helper.id).join(",")}\n${composedSource}`;
}
