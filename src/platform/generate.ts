import type {
	PlatformDocumentation,
	PlatformModule,
	PlatformType,
	PlatformTypeDefinition,
} from "./catalog.ts";

function documentation(
	value: PlatformDocumentation,
	indent: string,
	reference?: string,
): string {
	const lines: Array<string> = [];
	let line = "";
	for (const word of value.description.split(/\s+/)) {
		if (line.length + word.length > 82 - indent.length) {
			lines.push(line);
			line = word;
		} else line += `${line.length === 0 ? "" : " "}${word}`;
	}
	if (line.length > 0) lines.push(line);
	// Full workflows belong on the reference page; hovers retain one short snippet.
	for (const example of (value.examples ?? [])
		.filter((entry) => entry.split("\n").length <= 12)
		.slice(0, 1))
		lines.push("", "@example", ...example.split("\n"));
	if (reference !== undefined) lines.push("", `@see ${reference}`);
	return `${indent}/**\n${lines.map((entry) => `${indent} *${entry.length === 0 ? "" : ` ${entry}`}`).join("\n")}\n${indent} */`;
}

export function renderPlatformType(type: PlatformType, indent = ""): string {
	switch (type.kind) {
		case "signature":
			return type.source;
		case "primitive":
			return type.name;
		case "literal":
			return JSON.stringify(type.value);
		case "reference":
			return type.name;
		case "array":
			return `ReadonlyArray<${renderPlatformType(type.element, indent)}>`;
		case "record":
			return `Readonly<Record<string, ${renderPlatformType(type.value, indent)}>>`;
		case "object":
			return `{\n${type.properties.map((property) => `${documentation(property, `${indent}\t`)}\n${indent}\treadonly ${property.name}: ${renderPlatformType(property.type, `${indent}\t`)};`).join("\n")}\n${indent}}`;
		case "union":
			return type.types.map((entry) => renderPlatformType(entry, indent)).join(" | ");
		case "intersection":
			return type.types
				.map((entry) =>
					entry.kind === "union"
						? `(${renderPlatformType(entry, indent)})`
						: renderPlatformType(entry, indent),
				)
				.join(" & ");
	}
}

export function renderTypeDeclaration(type: PlatformTypeDefinition, indent = ""): string {
	const body = renderPlatformType(type.type, indent);
	if (type.declaration === "interface") {
		const heritage = type.extends?.length ? ` extends ${type.extends.join(", ")}` : "";
		return `interface ${type.name}${heritage} ${body}`;
	}
	return `type ${type.name} = ${body};`;
}

export function generatePlatformDeclarations(platform: PlatformModule): string {
	return [
		"// Generated from src/platform/catalog.ts; edit the catalog and regenerate.",
		documentation(platform, ""),
		`declare module ${JSON.stringify(platform.id)} {`,
		...(platform.typeImports ?? []).map(
			(entry) =>
				`\timport type * as ${entry.namespace} from ${JSON.stringify(entry.from)};`,
		),
		...platform.types.flatMap((type) => {
			const name = type.name.split("<")[0]!;
			const anchor = platform.exports.some((entry) => entry.name === name)
				? `${name}.type`
				: name;
			return [
				documentation(
					type,
					"\t",
					platform.internal
						? undefined
						: `https://maligator.ddv.tools/api/${platform.id.slice("maligator:".length)}#${anchor}`,
				),
				`\texport ${renderTypeDeclaration(type, "\t")}`,
				"",
			];
		}),
		...platform.exports.flatMap((entry) => [
			documentation(
				entry,
				"\t",
				platform.internal
					? undefined
					: `https://maligator.ddv.tools/api/${platform.id.slice("maligator:".length)}#${entry.name}`,
			),
			`\texport const ${entry.name}: ${renderPlatformType(entry.type, "\t")};`,
		]),
		"}",
		"",
	].join("\n");
}
