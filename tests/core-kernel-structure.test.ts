import { readdirSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript-v6-api";
import { describe, expect, it } from "vitest";

const CORE_DIRECTORY = "src/compiler/core";
const TARGET_DIRECTORY = "src/compiler/target";
const EXCLUDED_CORE_SOURCES = new Set([
	"core-debug-view.ts",
	"core-format.ts",
	"core-optimization-report.ts",
	"core-store.ts",
]);
const ALLOCATING_READERS = new Set([
	"blockHandler",
	"blockLayout",
	"blockParameters",
	"effectRefinementLayout",
	"instructionOperands",
	"instructionLayout",
	"instructionResults",
	"operandRecord",
	"terminatorPayload",
	"useLayout",
	"uses",
	"valueDefinition",
	"valueLayout",
]);
const LEGACY_STORE_MEMBERS = new Set(["parameters", ...ALLOCATING_READERS]);

function productionSources(): ReadonlyArray<string> {
	const core = readdirSync(CORE_DIRECTORY, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				!EXCLUDED_CORE_SOURCES.has(entry.name),
		)
		.map((entry) => path.join(CORE_DIRECTORY, entry.name));
	const target = readdirSync(TARGET_DIRECTORY, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".ts") &&
				(entry.name.startsWith("lower-") || entry.name.startsWith("verify-")),
		)
		.map((entry) => path.join(TARGET_DIRECTORY, entry.name));
	return [...core, ...target].sort();
}

const COMPILER_STATE_SOURCES = [
	"src/compiler/shared/compiler-facts.ts",
	"src/compiler/shared/fact-implication.ts",
];

function sourcePosition(source: ts.SourceFile, node: ts.Node): string {
	const location = source.getLineAndCharacterOfPosition(node.getStart(source));
	return `${path.relative(process.cwd(), source.fileName)}:${location.line + 1}:${location.character + 1}`;
}

function namedAccess(
	node: ts.Node,
): { readonly name: string; readonly receiver: ts.Expression } | undefined {
	if (ts.isPropertyAccessExpression(node)) {
		return { name: node.name.text, receiver: node.expression };
	}
	if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
		return { name: node.argumentExpression.text, receiver: node.expression };
	}
	return undefined;
}

describe("Core kernel source structure", () => {
	it("keeps serialization out of optimizer state identity", () => {
		const violations: Array<string> = [];
		for (const sourcePath of [...productionSources(), ...COMPILER_STATE_SOURCES]) {
			const source = ts.createSourceFile(
				sourcePath,
				ts.sys.readFile(sourcePath) ?? "",
				ts.ScriptTarget.Latest,
				true,
			);
			const visit = (node: ts.Node): void => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					ts.isIdentifier(node.expression.expression) &&
					node.expression.expression.text === "JSON" &&
					node.expression.name.text === "stringify"
				) {
					violations.push(sourcePosition(source, node));
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}

		expect(violations).toEqual([]);
	});

	it("keeps allocating Core snapshots out of production optimization and lowering", () => {
		const config = ts.readConfigFile("tsconfig.json", (file) => ts.sys.readFile(file));
		if (config.error !== undefined) {
			throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
		}
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
		const sources = productionSources().map((source) => path.resolve(source));
		const program = ts.createProgram(sources, parsed.options);
		const checker = program.getTypeChecker();
		const storeSource = program.getSourceFile(
			path.resolve(CORE_DIRECTORY, "core-store.ts"),
		);
		const storeDeclaration = storeSource?.statements.find(
			(statement): statement is ts.ClassDeclaration =>
				ts.isClassDeclaration(statement) && statement.name?.text === "CoreFunctionStore",
		);
		if (storeDeclaration?.name === undefined) {
			throw new Error("CoreFunctionStore declaration is unavailable");
		}
		const storeType = checker.getTypeAtLocation(storeDeclaration.name);
		const violations: Array<string> = [];
		for (const member of storeDeclaration.members) {
			const name = member.name;
			if (
				name !== undefined &&
				(ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
				LEGACY_STORE_MEMBERS.has(name.text)
			) {
				violations.push(`${sourcePosition(storeSource!, member)} declares ${name.text}`);
			}
		}

		for (const sourcePath of sources) {
			const source = program.getSourceFile(sourcePath);
			if (source === undefined) throw new Error(`Missing parsed source ${sourcePath}`);
			const visit = (node: ts.Node): void => {
				if (
					ts.isImportDeclaration(node) &&
					ts.isStringLiteral(node.moduleSpecifier) &&
					node.moduleSpecifier.text.endsWith("/core-debug-view.ts")
				) {
					violations.push(`${sourcePosition(source, node)} imports core-debug-view`);
				}
				const access = namedAccess(node);
				if (access !== undefined) {
					const reader = access.name;
					const readsParameters = reader === "parameters";
					const callsReader =
						ALLOCATING_READERS.has(reader) &&
						ts.isCallExpression(node.parent) &&
						node.parent.expression === node;
					if (
						(readsParameters || callsReader) &&
						checker.isTypeAssignableTo(
							checker.getTypeAtLocation(access.receiver),
							storeType,
						)
					) {
						violations.push(`${sourcePosition(source, node)} reads ${reader}`);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}

		expect(violations).toEqual([]);
	});
});
