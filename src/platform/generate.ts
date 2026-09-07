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

export function generatePlatformDeclarations(module: PlatformModule): string {
	return [
		"// Generated from src/platform/catalog.ts; edit the catalog and regenerate.",
		documentation(module, ""),
		`declare module ${JSON.stringify(module.id)} {`,
		...module.types.flatMap((type) => [
			documentation(type, "\t"),
			`\texport type ${type.name} = ${renderPlatformType(type.type, "\t")};`,
			"",
		]),
		...module.exports.flatMap((entry) => [
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

export function generatePlatformReference(module: PlatformModule): string {
	const exports = module.exports
		.map(
			(entry) =>
				`<section><h2 id="${html(entry.name)}">${html(entry.name)}</h2><p>${html(entry.description)}</p><p>Phase: ${entry.contract.phase}. Value: ${entry.contract.value}. Identity: ${entry.contract.identity}.</p>${(entry.examples ?? []).map((example) => `<pre><code>${html(example)}</code></pre>`).join("\n")}</section>`,
		)
		.join("\n");
	const types = module.types
		.map(
			(type) =>
				`<section><h2 id="${html(type.name)}">${html(type.name)}</h2><p>${html(type.description)}</p><pre><code>${html(`type ${type.name} = ${renderPlatformType(type.type)};`)}</code></pre></section>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(module.id)} — Maligator API reference</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:900px;margin:3rem auto;padding:0 1.5rem;color:#20252b;background:#fafafa}h1,h2{line-height:1.2}h2{margin-top:2.5rem}pre{overflow:auto;padding:1.25rem;border:1px solid #ddd;border-radius:8px;background:white;font-size:14px}a{color:#175fa6}code{font-family:ui-monospace,monospace}</style>
</head>
<body>
<nav><a href="/">Maligator</a> / API reference</nav>
<main><h1>${html(module.id)}</h1><p>${html(module.description)}</p><p>Status: ${module.stability}. Module evaluation: ${module.evaluation}.</p>
<p>TypeScript: include <code>@maligator/cli</code> in your tsconfig <code>compilerOptions.types</code> or add <code>/// &lt;reference types="@maligator/cli" /&gt;</code> to a declaration file.</p>
${exports}
${types}
</main>
</body>
</html>
`;
}
