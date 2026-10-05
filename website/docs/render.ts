import { readFileSync } from "node:fs";
import { Marked } from "marked";
import { renderSiteTemplate } from "../templates/layout.ts";
import { guides, references } from "./model.ts";
import type { DocPage, ReferenceSymbol } from "./model.ts";

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function headingId(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export function renderDocumentation(
	page: DocPage,
	symbols: ReadonlyArray<ReferenceSymbol>,
	version: string,
	revision: string,
	prepared = false,
): string {
	const toc: Array<{ id: string; title: string }> = [];
	const ids = new Set<string>();
	const signatures = new Set(
		symbols
			.filter((symbol) => symbol.url.startsWith(`${page.url}#`))
			.map((symbol) => symbol.signature.trim()),
	);
	const marked = new Marked({
		renderer: {
			heading({ text, depth, tokens }) {
				const explicit = text.match(/ \{#([^}]+)\}$/)?.[1];
				const title = text.replace(/ \{#[^}]+\}$/, "");
				const id = explicit ?? headingId(title);
				if (ids.has(id)) throw new Error(`Duplicate heading ${page.url}#${id}`);
				ids.add(id);
				if (depth === 2) toc.push({ id, title: title.replaceAll("`", "") });
				const content = this.parser.parseInline(tokens).replace(/ \{#[^}]+\}$/, "");
				return `<h${depth} id="${escapeHtml(id)}"><a class="heading-link" href="#${escapeHtml(id)}">${content}</a></h${depth}>\n`;
			},
			code({ text, lang }) {
				const [language = "text", ...label] = (lang ?? "text").split(/\s+/);
				const filename = label.join(" ");
				return `<div class="code-block" data-example="${!signatures.has(text.trim())}"><div class="code-tools" data-pagefind-ignore><span>${escapeHtml(filename || language)}</span><button type="button" class="copy-code" aria-label="Copy ${escapeHtml(filename || language)} code">Copy</button></div><pre data-language="${escapeHtml(language)}"><code>${escapeHtml(text)}</code></pre></div>\n`;
			},
		},
	});
	let body = marked.parse(page.markdown, { async: false });
	const local = symbols.filter((symbol) => symbol.url.startsWith(`${page.url}#`));
	const links = new Map(local.map((symbol) => [symbol.name, symbol.url]));
	for (const symbol of symbols)
		if (!links.has(symbol.name)) links.set(symbol.name, symbol.url);
	// Text inside preformatted code must stay copyable; link standalone type references only.
	body = body
		.split(/(<pre[\s\S]*?<\/pre>)/g)
		.map((part) =>
			part.startsWith("<pre")
				? part
				: part.replace(/(?<!<a[^>]*>)<code>([\w.]+)<\/code>/g, (match, name: string) => {
						const url = links.get(name);
						return url === undefined
							? match
							: `<a href="${escapeHtml(url)}">${match}</a>`;
					}),
		)
		.join("");
	if (page.layer === "API reference") {
		body = body
			.split(/(?=<h2 )/g)
			.map((part) => {
				if (!part.startsWith("<h2 ")) return part;
				const examples = Array.from(
					part.matchAll(
						/<div class="code-block" data-example="true">[\s\S]*?<\/pre><\/div>/g,
					),
					(match) => match[0],
				);
				if (examples.length === 0) return part;
				for (const example of examples) part = part.replace(example, "");
				return `<section class="api-entry has-examples"><div class="api-contract">${part}</div><div class="api-examples" aria-label="Examples">${examples.join("\n")}</div></section>`;
			})
			.join("");
	}
	const nav = (
		entries: ReadonlyArray<readonly [string, string, string]>,
		prefix: string,
	) =>
		entries
			.map(
				([slug, title]) =>
					`<a href="${prefix}/${slug}"${page.url === `${prefix}/${slug}` ? ' aria-current="page"' : ""}>${escapeHtml(title)}</a>`,
			)
			.join("");
	const guideIndex = guides.findIndex(([slug]) => page.url === `/guides/${slug}`);
	const adjacent =
		guideIndex < 0
			? ""
			: [guides[guideIndex - 1], guides[guideIndex + 1]]
					.map((entry, index) =>
						entry === undefined
							? "<span></span>"
							: `<a href="/guides/${entry[0]}"><small>${index === 0 ? "Previous" : "Next"}</small>${escapeHtml(entry[1])}</a>`,
					)
					.join("");
	return renderSiteTemplate(
		`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} — Maligator docs</title><meta name="description" content="${escapeHtml(page.summary)}">
<link rel="canonical" href="https://maligator.ddv.tools${page.url}">
<link rel="alternate" type="text/markdown" href="${page.url}.md" title="Markdown">
__SITE_ICONS____SITE_STYLES__<style>${readFileSync("website/docs/docs.css", "utf8")}</style>
<script type="module" src="/docs/assets/client.js"></script></head>
<body data-search-ready="${prepared}"><a class="skip-link" href="#main">Skip to content</a>__SITE_NAVIGATION__
<div class="docs-toolbar"><nav aria-label="Documentation layers"><a href="/guides"${page.layer === "Guides" ? ' aria-current="location"' : ""}>Guides</a><a href="/api"${page.layer === "API reference" ? ' aria-current="location"' : ""}>API reference</a></nav><button type="button" id="open-search">Search docs <kbd>⌘ K</kbd></button></div>
<div class="docs-layout"><details class="docs-menu" open><summary>Documentation menu</summary><nav aria-label="Documentation topics"><a href="/docs"${page.url === "/docs" ? ' aria-current="page"' : ""}>Documentation</a><p>Guides</p>${nav(guides, "/guides")}<p>API reference</p>${nav(references, "/api")}</nav></details>
<main id="main"><article data-pagefind-body data-pagefind-weight="${page.layer === "Guides" ? "2" : "1"}"><div class="page-meta" data-pagefind-ignore><span>${page.layer}</span><a href="${page.url}.md">Markdown ↗</a></div><h1 data-pagefind-meta="title">${escapeHtml(page.title)}</h1><details class="inline-contents" data-pagefind-ignore><summary>On this page</summary><nav>${toc.map((entry) => `<a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</a>`).join("")}</nav></details><span class="visually-hidden" data-pagefind-meta="layer">${page.layer}</span><span class="visually-hidden" data-pagefind-meta="version">${escapeHtml(version)}</span>${body}</article>${adjacent ? `<nav class="adjacent" aria-label="Guide sequence">${adjacent}</nav>` : ""}<div class="source-meta">Maligator ${escapeHtml(version)} · Experimental · Source ${escapeHtml(revision.slice(0, 12))}<br><a href="https://github.com/dirkdev98/maligator/blob/${revision}/${page.source}">Edit this page</a> · <a href="/compatibility">Compatibility</a></div></main>
<aside class="page-contents"><nav aria-label="On this page"><p>On this page</p>${toc.map((entry) => `<a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</a>`).join("")}</nav></aside></div>
__SITE_FOOTER__<dialog id="search-dialog" aria-labelledby="search-label"><div class="search-heading"><label id="search-label" for="search-input">Search documentation</label><button type="button" id="close-search" aria-label="Close search">Esc</button></div><input id="search-input" type="search" placeholder="Search a task, symbol, or flag" autocomplete="off"><p id="search-status" role="status">Search guides and API reference.</p><div id="search-results"></div><p class="search-help"><a href="/api">Browse the API</a> · <a href="/guides/troubleshooting">Troubleshooting</a></p></dialog></body></html>`,
		"api",
	);
}
