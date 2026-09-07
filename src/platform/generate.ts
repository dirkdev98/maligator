import ts from "typescript";
import type { PlatformDocumentation, PlatformModule, PlatformType } from "./catalog.ts";

function documentation(value: PlatformDocumentation, indent: string): string {
	const lines: Array<string> = [];
	let line = "";
	for (const word of value.description.split(/\s+/)) {
		if (line.length + word.length > 82 - indent.length) {
			lines.push(line);
			line = word;
		} else line += `${line.length === 0 ? "" : " "}${word}`;
	}
	if (line.length > 0) lines.push(line);
	for (const example of value.examples ?? [])
		lines.push("", "@example", ...example.split("\n"));
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

export function generatePlatformDeclarations(platform: PlatformModule): string {
	return [
		"// Generated from src/platform/catalog.ts; edit the catalog and regenerate.",
		documentation(platform, ""),
		`declare module ${JSON.stringify(platform.id)} {`,
		...platform.types.flatMap((type) => [
			documentation(type, "\t"),
			`\texport type ${type.name} = ${renderPlatformType(type.type, "\t")};`,
			"",
		]),
		...platform.exports.flatMap((entry) => [
			documentation(entry, "\t"),
			`\texport const ${entry.name}: ${renderPlatformType(entry.type, "\t")};`,
		]),
		"}",
		"",
	].join("\n");
}

function html(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function prose(value: string): string {
	return html(value)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\{@link ([\w.]+)\}/g, "<code>$1</code>");
}

function referenceType(type: PlatformType): string {
	switch (type.kind) {
		case "reference":
			return `<a href="#${html(type.name)}">${html(type.name)}</a>`;
		case "object":
			return "{ … }";
		case "array":
			return `ReadonlyArray&lt;${referenceType(type.element)}&gt;`;
		case "record":
			return `Readonly&lt;Record&lt;string, ${referenceType(type.value)}&gt;&gt;`;
		case "union":
		case "intersection":
			return type.types
				.map(referenceType)
				.join(type.kind === "union" ? " | " : " &amp; ");
		default:
			return html(renderPlatformType(type));
	}
}

function propertyDocumentation(type: PlatformType, owner: string): string {
	if (type.kind === "object") {
		return `<dl class="properties">${type.properties
			.map((property) => {
				const id = `${owner}.${property.name}`;
				return `<div class="property" id="${html(id)}"><dt><a class="property-name" href="#${html(id)}"><code>${html(property.name)}</code></a><span class="qualifier">readonly</span><code class="property-type">${referenceType(property.type)}</code></dt><dd><p>${prose(property.description)}</p>${property.type.kind === "object" ? propertyDocumentation(property.type, id) : ""}</dd></div>`;
			})
			.join("\n")}</dl>`;
	}
	if (type.kind === "intersection") {
		return type.types
			.map((part, index) =>
				part.kind === "reference"
					? `<p class="type-note">Includes all properties of <code>${referenceType(part)}</code>.</p>`
					: propertyDocumentation(part, `${owner}.${index}`),
			)
			.join("\n");
	}
	if (type.kind === "union" && type.types.some((part) => part.kind === "object")) {
		return type.types
			.map((part, index) => {
				const command =
					part.kind === "object"
						? part.properties.find((property) => property.name === "command")
						: undefined;
				return `<div class="type-variant"><h3>${command ? `When <code>command</code> is <code>${referenceType(command.type)}</code>` : `Variant ${index + 1}`}</h3>${propertyDocumentation(part, `${owner}.${index}`)}</div>`;
			})
			.join("\n");
	}
	if (type.kind === "signature") {
		const source = ts.createSourceFile(
			"reference.ts",
			`type Reference = ${type.source};`,
			ts.ScriptTarget.Latest,
			true,
		);
		const declaration = source.statements[0];
		if (
			declaration &&
			ts.isTypeAliasDeclaration(declaration) &&
			ts.isTypeLiteralNode(declaration.type)
		) {
			return `<dl class="properties">${declaration.type.members
				.map((member, index) => {
					const name = member.name?.getText(source) ?? "call";
					const id = `${owner}.${name}.${index}`;
					const description = (ts.getLeadingCommentRanges(source.text, member.pos) ?? [])
						.map((comment) =>
							source.text
								.slice(comment.pos, comment.end)
								.replace(/^\/\*\*?|\*\/$/g, "")
								.replace(/^\s*\*\s?/gm, ""),
						)
						.join(" ")
						.replace(/\s+/g, " ")
						.trim();
					const signature = member.getText(source).replace(/;$/, "");
					return `<div class="property" id="${html(id)}"><dt><a class="member-signature" href="#${html(id)}"><code>${html(signature)}</code></a></dt><dd>${description ? `<p>${prose(description)}</p>` : ""}</dd></div>`;
				})
				.join("\n")}</dl>`;
		}
	}
	return "";
}

export function generatePlatformReference(
	platform: PlatformModule,
	modules: ReadonlyArray<PlatformModule> = [platform],
): string {
	const exports = platform.exports
		.map(
			(entry) =>
				`<section><h2 id="${html(entry.name)}">${html(entry.name)}</h2><p>${html(entry.description)}</p><p>Phase: ${entry.contract.phase}. Value: ${entry.contract.value}. Identity: ${entry.contract.identity}.</p>${(entry.examples ?? []).map((example) => `<pre><code>${html(example)}</code></pre>`).join("\n")}</section>`,
		)
		.join("\n");
	const types = platform.types
		.map((type) => {
			const properties = propertyDocumentation(type.type, type.name);
			const declaration = `<pre><code>${html(`type ${type.name} = ${renderPlatformType(type.type)};`)}</code></pre>`;
			return `<section class="type-section"><h2 id="${html(type.name)}">${html(type.name)}</h2><p>${prose(type.description)}</p>${properties}${properties ? `<details class="declaration"><summary>TypeScript declaration</summary>${declaration}</details>` : declaration}</section>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(platform.id)} — Maligator API reference</title>
__API_STYLES__
__SITE_STYLES__
</head>
<body>
__SITE_NAVIGATION__
<nav class="api-navigation" aria-label="API reference">${modules.map((entry) => `<a href="/api/${html(entry.id.slice("maligator:".length))}"${entry.id === platform.id ? ' aria-current="page"' : ""}>${html(entry.id)}</a>`).join(" · ")}</nav>
<main id="main"><h1>${html(platform.id)}</h1><p>${html(platform.description)}</p><p>Status: ${platform.stability}. Module evaluation: ${platform.evaluation}.</p>
<p>TypeScript: include <code>@maligator/cli</code> in your tsconfig <code>compilerOptions.types</code> or add <code>/// &lt;reference types="@maligator/cli" /&gt;</code> to a declaration file.</p>
${exports}
${types}
</main>
__SITE_FOOTER__
</body>
</html>
`;
}
