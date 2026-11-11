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

/** The key a module's specifier map uses: data imports of a specifier are distinct. */
export function moduleDependencyKey(
	specifier: string,
	importType: ModuleImportType | undefined,
): string {
	return importType === undefined ? specifier : `${specifier}\0${importType}`;
}
