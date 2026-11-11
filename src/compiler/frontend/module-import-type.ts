import type { ESTree } from "meriyah";

/** A module type selected by the `type` import attribute that reads a file as data. */
export type ModuleImportType = "text" | "bytes";

/** The data module type a declaration's `type` import attribute selects, if any. */
export function moduleImportType(node: {
	readonly attributes?: ReadonlyArray<ESTree.ImportAttribute> | null;
}): ModuleImportType | undefined {
	for (const attribute of node.attributes ?? []) {
		const key =
			attribute.key.type === "Identifier" ? attribute.key.name : attribute.key.value;
		if (key !== "type") continue;
		const value = attribute.value.value;
		return value === "text" || value === "bytes" ? value : undefined;
	}
	return undefined;
}

/**
 * The data module type a literal `import(x, { with: { type } })` options object
 * selects. Options that are not plain literal data stay unresolved here; the
 * runtime still evaluates and validates them.
 */
export function dynamicImportType(
	options: ESTree.Expression | null | undefined,
): ModuleImportType | undefined {
	const attributes = literalProperty(options, "with");
	const type = literalProperty(attributes, "type");
	return type?.type === "Literal" && (type.value === "text" || type.value === "bytes")
		? type.value
		: undefined;
}

function literalProperty(
	node: ESTree.Node | null | undefined,
	name: string,
): ESTree.Node | undefined {
	if (node?.type !== "ObjectExpression") return undefined;
	for (const property of node.properties) {
		if (property.type !== "Property" || property.kind !== "init" || property.computed)
			continue;
		const key =
			property.key.type === "Identifier"
				? property.key.name
				: property.key.type === "Literal"
					? property.key.value
					: undefined;
		if (key === name) return property.value;
	}
	return undefined;
}

/** The key a module's specifier map uses: data imports of a specifier are distinct. */
export function moduleDependencyKey(
	specifier: string,
	importType: ModuleImportType | undefined,
): string {
	return importType === undefined ? specifier : `${specifier}\0${importType}`;
}
