import type { ESTree } from "meriyah";
import type { ModuleGraph } from "./module-graph.ts";

function exportName(node: ESTree.Identifier | ESTree.Literal): string {
	return node.type === "Identifier" ? node.name : String(node.value);
}

/**
 * Whether a program can register a C callback: an FFI export it imports or
 * re-exports reaches a callback registration, or it loads a library with one at run
 * time, where any export is readable. The static imports are the whole set only for
 * a known source closure.
 */
export function importsForeignCallbacks(graph: ModuleGraph): boolean {
	const libraries = new Map<string, ReadonlySet<string>>();
	for (const [path, record] of graph.modules) {
		const exports = record.host?.callbacks?.exports;
		if (exports !== undefined && exports.length > 0)
			libraries.set(path, new Set(exports));
	}
	if (libraries.size === 0) return false;
	const reach = (path: string | null | undefined): ReadonlySet<string> | undefined =>
		path === null || path === undefined ? undefined : libraries.get(path);
	for (const record of graph.modules.values()) {
		if (record.host !== undefined) continue;
		for (const dependency of record.dependencies)
			if (
				dependency.kind !== "import" &&
				dependency.kind !== "export" &&
				reach(dependency.resolvedPath) !== undefined
			)
				return true;
		const resolved = new Map(
			record.dependencies.flatMap((dependency) =>
				dependency.specifier === null || dependency.resolvedPath === null
					? []
					: [[dependency.specifier, dependency.resolvedPath] as const],
			),
		);
		for (const statement of record.parsed.ast.body) {
			if (
				(statement.type !== "ImportDeclaration" &&
					statement.type !== "ExportNamedDeclaration" &&
					statement.type !== "ExportAllDeclaration") ||
				statement.source === null ||
				statement.source === undefined
			)
				continue;
			const exports = reach(resolved.get(String(statement.source.value)));
			if (exports === undefined) continue;
			if (statement.type === "ExportAllDeclaration") return true;
			for (const specifier of statement.specifiers) {
				if (specifier.type === "ImportNamespaceSpecifier") return true;
				const name =
					specifier.type === "ImportDefaultSpecifier"
						? "default"
						: specifier.type === "ImportSpecifier"
							? exportName(specifier.imported)
							: exportName(specifier.local);
				if (exports.has(name)) return true;
			}
		}
	}
	return false;
}
