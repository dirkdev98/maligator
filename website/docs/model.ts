import { readFileSync } from "node:fs";
import ts from "typescript-v6-api";
import { PLATFORM_MODULES, workerExamples } from "../../src/platform/catalog.ts";
import type { PlatformType } from "../../src/platform/catalog.ts";
import {
	renderPlatformType,
	renderTypeDeclaration,
} from "../../src/platform/generate.ts";

export interface DocPage {
	url: string;
	title: string;
	summary: string;
	layer: "Guides" | "API reference" | "Documentation";
	source: string;
	markdown: string;
}

export interface ReferenceSymbol {
	name: string;
	kind: "export" | "type" | "member" | "command";
	signature: string;
	module: string;
	url: string;
	description: string;
	availability: string;
	default?: string;
	guides?: Array<string>;
}

export const guides = [
	[
		"getting-started",
		"Getting started",
		"Install Maligator and run your first application.",
	],
	[
		"development",
		"Develop an application",
		"Watch source files and restart after successful builds.",
	],
	["typescript", "Use TypeScript", "Load declarations and check your application."],
	[
		"testing",
		"Test an application",
		"Write assertions, filter tests, and watch changes.",
	],
	[
		"workers",
		"Run tasks in workers",
		"Create a persistent pool with isolated module state.",
	],
	[
		"workers/messages",
		"Messages and transfers",
		"Choose what to copy, move, or share between isolates.",
	],
	[
		"workers/cancellation",
		"Cancel work and shut down",
		"Signal cancellation and release worker resources.",
	],
	[
		"build-configuration",
		"Configure a build",
		"Choose engine features, host surfaces, and module aliases.",
	],
	[
		"assets",
		"Embed files",
		"Capture files at build time and materialize them at runtime.",
	],
	["http", "Serve HTTP", "Start a listener and return responses."],
	[
		"production",
		"Build for production",
		"Create a native executable or deployable artifact.",
	],
	["profiling", "Profile an application", "Capture CPU, allocation, and GC evidence."],
	[
		"troubleshooting",
		"Troubleshooting",
		"Diagnose configuration, build, and runtime failures.",
	],
	[
		"contributing",
		"Develop Maligator",
		"Set up the compiler repository and select focused checks.",
	],
] as const;

export const references = [
	["build", "Build configuration", "defineBuild, engine features, surfaces, and assets."],
	[
		"application",
		"Application lifecycle",
		"Notify the development supervisor when startup is complete.",
	],
	[
		"process",
		"Execution context",
		"Read immutable compile-time command and configuration values.",
	],
	["workers", "Workers", "Pools, isolated modules, channels, and transfers."],
	["test", "Test API", "Tests, suites, hooks, and assertions."],
	["runtime", "Runtime globals", "Materialize assets with mal and serve HTTP with Mal."],
	["cli", "CLI", "Commands, flags, defaults, and output paths."],
] as const;

function fenced(code: string, language = "typescript", filename = ""): string {
	return `\n\`\`\`${language}${filename ? ` ${filename}` : ""}\n${code.trim()}\n\`\`\`\n`;
}

function expandExamples(markdown: string): string {
	return markdown.replace(/\{\{example:([\w.-]+)\}\}/g, (_match, name: string) => {
		if (name.startsWith("workers.")) {
			const key = name.slice(8) as keyof typeof workerExamples;
			const source = workerExamples[key];
			if (source === undefined) throw new Error(`Unknown example: ${name}`);
			const filename = source.match(/^\/\/ (.+)\n/)?.[1] ?? "";
			return fenced(source.replace(/^\/\/ .+\n/, ""), "typescript", filename);
		}
		const file = `website/docs/examples/${name}`;
		return fenced(
			readFileSync(file, "utf8"),
			file.endsWith(".json") ? "json" : "typescript",
			name,
		);
	});
}

export function comments(
	node: ts.Node,
	source: ts.SourceFile,
): { description: string; default?: string } {
	const blocks = ts.getLeadingCommentRanges(source.text, node.pos) ?? [];
	const text = blocks
		.map((range) =>
			source.text
				.slice(range.pos, range.end)
				.replace(/^\/\*\*?|\*\/$/g, "")
				.replace(/^\s*\* ?/gm, "")
				.trim(),
		)
		.join("\n");
	const defaultValue = text.match(/@default\s+([^\n]+)/)?.[1]?.trim();
	return {
		description: text
			.replace(/@see[^\n]+/g, "")
			.replace(/@default\s+([^\n]+)/g, "Default: `$1`.")
			.replace(/@example\s*([\s\S]*)/, (_match, code: string) => fenced(code))
			.replace(/\{@link ([\w.]+)\}/g, "`$1`")
			.trim(),
		...(defaultValue === undefined ? {} : { default: defaultValue }),
	};
}

function typeMembers(type: ts.TypeNode | undefined): ReadonlyArray<ts.TypeElement> {
	if (type === undefined) return [];
	if (ts.isTypeLiteralNode(type)) return type.members;
	if (ts.isIntersectionTypeNode(type) || ts.isUnionTypeNode(type))
		return type.types.flatMap(typeMembers);
	return [];
}

function section(
	name: string,
	signature: string,
	description: string,
	depth = 2,
	collapsed = false,
	anchor = name,
): string {
	return `\n${"#".repeat(depth)} ${name} {#${anchor}}\n\n${description}\n${collapsed ? `<details><summary>Full TypeScript declaration</summary>\n\n${fenced(signature)}\n</details>\n` : fenced(signature)}\n`;
}

function addMembers(
	members: ReadonlyArray<ts.TypeElement>,
	source: ts.SourceFile,
	owner: string,
	module: string,
	url: string,
	symbols: Array<ReferenceSymbol>,
	availability: string,
): string {
	const seen = new Set<string>();
	return members
		.map((member) => {
			if (member.name === undefined) return "";
			const key = member.name.getText(source).replace(/^['"]|['"]$/g, "");
			const name = owner ? `${owner}.${key}` : key;
			if (seen.has(name)) return "";
			seen.add(name);
			const docs = comments(member, source);
			const signature = member.getText(source);
			symbols.push({
				name,
				kind: "member",
				signature,
				module,
				url: `${url}#${name}`,
				availability,
				...docs,
			});
			const nested = ts.isPropertySignature(member) ? typeMembers(member.type) : [];
			return (
				section(name, signature, docs.description, 3, nested.length > 0) +
				addMembers(nested, source, name, module, url, symbols, availability)
			);
		})
		.join("");
}

function platformMembers(
	type: PlatformType,
	name: string,
	module: string,
	url: string,
	symbols: Array<ReferenceSymbol>,
): string {
	const source = ts.createSourceFile(
		"reference.ts",
		`type Reference = ${renderPlatformType(type)};`,
		ts.ScriptTarget.Latest,
		true,
	);
	const declaration = source.statements[0];
	if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) return "";
	return addMembers(
		typeMembers(declaration.type),
		source,
		name,
		module,
		url,
		symbols,
		"Experimental; no surface flag required.",
	);
}

function platformReference(id: string, symbols: Array<ReferenceSymbol>): string {
	const platform = PLATFORM_MODULES.find((entry) => entry.id === `maligator:${id}`);
	if (platform === undefined || platform.internal)
		throw new Error(`Unknown public module: ${id}`);
	const url = `/api/${id}`;
	let markdown =
		`${platform.description}\n\nImport from \`${platform.id}\`. This API is ${platform.stability}. ` +
		"Load declarations as described in [Use TypeScript](/guides/typescript). Platform imports do not require a surface flag.\n";
	markdown += readFileSync(`website/docs/api/${id}.md`, "utf8");
	const exports = [...platform.exports];
	if (id === "workers")
		exports.sort((a, b) =>
			a.name === "createPool" ? -1 : b.name === "createPool" ? 1 : 0,
		);
	for (const entry of exports) {
		const signature = `export const ${entry.name}: ${renderPlatformType(entry.type)};`;
		symbols.push({
			name: entry.name,
			kind: "export",
			signature,
			module: platform.id,
			url: `${url}#${entry.name}`,
			description: entry.description,
			availability: platform.stability,
		});
		markdown += section(entry.name, signature, entry.description);
		for (const example of entry.examples ?? []) {
			const filename = example.match(/^\/\/ (.+)\n/)?.[1] ?? "";
			markdown += fenced(example.replace(/^\/\/ .+\n/, ""), "typescript", filename);
		}
	}
	for (const type of platform.types) {
		const name = type.name.split("<")[0]!;
		const signature = renderTypeDeclaration(type);
		symbols.push({
			name,
			kind: "type",
			signature,
			module: platform.id,
			url: `${url}#${name}`,
			description: type.description,
			availability: platform.stability,
		});
		const anchor = platform.exports.some((entry) => entry.name === name)
			? `${name}.type`
			: name;
		symbols[symbols.length - 1]!.url = `${url}#${anchor}`;
		const owner =
			(
				{
					TestFunction: "test",
					DescribeFunction: "describe",
					ExpectFunction: "expect",
				} as Record<string, string>
			)[name] ?? name;
		const members = platformMembers(type.type, owner, platform.id, url, symbols);
		markdown += section(
			anchor === name ? name : `${name} instance`,
			signature,
			type.description,
			2,
			members.length > 0,
			anchor,
		);
		markdown += members;
	}
	return markdown;
}

function publicReference(
	kind: "build" | "runtime",
	symbols: Array<ReferenceSymbol>,
): string {
	const source = ts.createSourceFile(
		"public-api.d.ts",
		readFileSync("src/public-api.d.ts", "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const buildNames = new Set([
		"MaligatorIntlFeature",
		"AssetInclusion",
		"MaligatorBuildConfig",
		"defineBuild",
	]);
	let markdown = readFileSync(`website/docs/api/${kind}.md`, "utf8");
	for (const node of source.statements) {
		if (
			!(
				ts.isInterfaceDeclaration(node) ||
				ts.isTypeAliasDeclaration(node) ||
				ts.isFunctionDeclaration(node)
			) ||
			node.name === undefined
		)
			continue;
		const name = node.name.text;
		if (buildNames.has(name) !== (kind === "build")) continue;
		const url = `/api/${kind}`;
		const docs = comments(node, source);
		const signature = node.getText(source);
		const availability =
			kind === "build"
				? "Build configuration; trusted project code."
				: "Requires the corresponding host surface.";
		symbols.push({
			name,
			kind: ts.isFunctionDeclaration(node) ? "export" : "type",
			signature,
			module: kind === "build" ? "@maligator/cli" : "global",
			url: `${url}#${name}`,
			availability,
			...docs,
		});
		markdown += section(
			name,
			signature,
			docs.description,
			2,
			ts.isInterfaceDeclaration(node) && node.members.length > 0,
		);
		if (ts.isInterfaceDeclaration(node)) {
			const owner =
				(
					{
						MaligatorBuildConfig: "",
						MaligatorAssets: "mal.assets",
						MaligatorWebRuntime: "Mal",
					} as Record<string, string>
				)[name] ?? name;
			markdown += addMembers(
				node.members,
				source,
				owner,
				kind === "build" ? "@maligator/cli" : "global",
				url,
				symbols,
				availability,
			);
		}
	}
	if (kind === "runtime") {
		for (const node of source.statements) {
			if (!ts.isModuleDeclaration(node) || !node.body || !ts.isModuleBlock(node.body))
				continue;
			for (const statement of node.body.statements) {
				if (!ts.isVariableStatement(statement)) continue;
				for (const declaration of statement.declarationList.declarations) {
					const name = declaration.name.getText(source);
					symbols.push({
						name,
						kind: "export",
						signature: `var ${declaration.getText(source)};`,
						module: "global",
						url: `/api/runtime#${name}`,
						availability:
							name === "mal"
								? "Requires surface.maligator."
								: "Requires surface.webPlatform.",
						...comments(statement, source),
					});
				}
			}
		}
	}
	return markdown;
}

export function documentationModel(): {
	pages: Array<DocPage>;
	symbols: Array<ReferenceSymbol>;
} {
	const symbols: Array<ReferenceSymbol> = [];
	const pages: Array<DocPage> = guides.map(([slug, title, summary]) => {
		const source = `website/docs/guides/${slug}.md`;
		return {
			url: `/guides/${slug}`,
			title,
			summary,
			layer: "Guides",
			source,
			markdown: expandExamples(readFileSync(source, "utf8")),
		};
	});
	for (const [id, title, summary] of references) {
		pages.push({
			url: `/api/${id}`,
			title,
			summary,
			layer: "API reference",
			source:
				id === "build" || id === "runtime"
					? "src/public-api.d.ts"
					: id === "cli"
						? "src/cli.ts"
						: "src/platform/catalog.ts",
			markdown: expandExamples(
				id === "build" || id === "runtime"
					? publicReference(id, symbols)
					: id === "cli"
						? readFileSync("website/docs/api/cli.md", "utf8")
						: platformReference(id, symbols),
			),
		});
	}
	for (const [url, title, layer] of [
		["/docs", "Documentation", "Documentation"],
		["/guides", "Guides", "Guides"],
		["/api", "API reference", "API reference"],
	] as const) {
		pages.unshift({
			url,
			title,
			layer,
			summary: "Build, run, and ship JavaScript applications with Maligator.",
			source: "website/docs/model.ts",
			markdown:
				url === "/docs"
					? readFileSync("website/docs/index.md", "utf8")
					: url === "/guides"
						? guides
								.map(
									([slug, name, summary]) => `- [${name}](/guides/${slug}) — ${summary}`,
								)
								.join("\n")
						: references
								.map(([slug, name, summary]) => `- [${name}](/api/${slug}) — ${summary}`)
								.join("\n"),
		});
	}
	const cli = pages.find((page) => page.url === "/api/cli")!;
	for (const match of cli.markdown.matchAll(/^## (.+) \{#([\w-]+)\}/gm)) {
		symbols.push({
			name: match[1]!,
			kind: "command",
			module: "CLI",
			signature: match[1]!,
			description: "Command and flag reference.",
			url: `/api/cli#${match[2]}`,
			availability: "CLI",
		});
	}
	for (const match of cli.markdown.matchAll(/^\| `(--[\w-]+)` \| ([^\n]+) \|$/gm)) {
		const before = cli.markdown.slice(0, match.index);
		const section =
			Array.from(before.matchAll(/^## .+ \{#([\w-]+)\}/gm)).at(-1)?.[1] ?? "build";
		symbols.push({
			name: match[1]!,
			kind: "command",
			module: "CLI",
			signature: match[1]!,
			description: match[2]!,
			url: `/api/cli#${section}`,
			availability: "CLI",
		});
	}
	for (const symbol of symbols) {
		symbol.description = symbol.description.replace(/\{@link ([\w.]+)\}/g, "`$1`");
		const page = pages.find((entry) => symbol.url.startsWith(`${entry.url}#`));
		symbol.guides = Array.from(
			new Set(
				Array.from(
					page?.markdown.matchAll(/\]\((\/guides[^)#]*)/g) ?? [],
					(match) => match[1]!,
				),
			),
		);
	}
	const apiIndex = pages.find((page) => page.url === "/api")!;
	apiIndex.markdown += references
		.map(([slug, title]) => {
			const entries = symbols.filter((symbol) => symbol.url.startsWith(`/api/${slug}#`));
			const primary = entries.filter((symbol) => symbol.kind !== "member");
			const members = entries.filter((symbol) => symbol.kind === "member");
			return `\n\n## ${title}\n\n${primary.map((symbol) => `- [\`${symbol.name}\`](${symbol.url}) — ${symbol.description}`).join("\n")}\n\n${members.length ? `<details><summary>Members and options (${members.length})</summary>\n\n${members.map((symbol) => `- [\`${symbol.name}\`](${symbol.url})`).join("\n")}\n\n</details>` : ""}`;
		})
		.join("");
	for (const page of pages) {
		const local = symbols.filter((symbol) => symbol.url.startsWith(`${page.url}#`));
		page.markdown = page.markdown.replace(
			/```typescript\n([\s\S]+?)\n```/g,
			(block, code: string) => {
				const signature = local.find((symbol) => symbol.signature.trim() === code.trim());
				if (signature === undefined) return block;
				const names = new Set(code.match(/\b[A-Za-z]\w*\b/g));
				const types = new Map<string, ReferenceSymbol>();
				for (const type of [...local, ...symbols]) {
					if (
						type.kind === "type" &&
						names.has(type.name) &&
						type.name !== signature.name &&
						!types.has(type.name)
					)
						types.set(type.name, type);
				}
				return types.size === 0
					? block
					: `${block}\n\nTypes: ${Array.from(types.values(), (type) => `[\`${type.name}\`](${type.url})`).join(", ")}\n`;
			},
		);
		page.markdown = page.markdown.replace(
			/\{@link ([\w.]+)\}/g,
			(_match, name: string) => {
				const target =
					symbols.find(
						(symbol) => symbol.name === name && symbol.url.startsWith(`${page.url}#`),
					) ?? symbols.find((symbol) => symbol.name === name);
				if (target === undefined)
					throw new Error(`Unresolved documentation link: ${name}`);
				return `[\`${name}\`](${target.url})`;
			},
		);
	}
	return { pages, symbols };
}
