import type { ReferenceSymbol } from "./model.ts";

interface SearchData {
	url: string;
	meta: { title?: string; layer?: string; version?: string };
	plain_excerpt: string;
	sub_results?: Array<{ url: string; title: string; plain_excerpt: string }>;
}
interface Pagefind {
	search(query: string): Promise<{ results: Array<{ data(): Promise<SearchData> }> }>;
}
const menu = document.querySelector<HTMLDetailsElement>(".docs-menu")!;
const narrow = matchMedia("(max-width: 720px)");
menu.open = !narrow.matches;
narrow.addEventListener("change", () => {
	menu.open = !narrow.matches;
});
const dialog = document.querySelector<HTMLDialogElement>("#search-dialog")!;
const input = document.querySelector<HTMLInputElement>("#search-input")!;
const status = document.querySelector<HTMLElement>("#search-status")!;
const results = document.querySelector<HTMLElement>("#search-results")!;
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let reference: Promise<{ version: string; symbols: Array<ReferenceSymbol> }> | undefined;
let pagefind: Promise<Pagefind> | undefined;

function openSearch(): void {
	dialog.showModal();
	input.focus();
}
document.querySelector("#open-search")!.addEventListener("click", openSearch);
document.querySelector("#close-search")!.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
	if (event.target === dialog) dialog.close();
});
document.addEventListener("keydown", (event) => {
	if (dialog.open && event.key === "Escape") {
		event.preventDefault();
		dialog.close();
		return;
	}
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		if (dialog.open) dialog.close();
		else openSearch();
	}
	if (dialog.open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
		const links = Array.from(results.querySelectorAll<HTMLAnchorElement>("a"));
		if (links.length === 0) return;
		event.preventDefault();
		const index = links.findIndex((link) => link === document.activeElement);
		if (event.key === "ArrowDown") links[(index + 1) % links.length]!.focus();
		else links[index <= 0 ? links.length - 1 : index - 1]!.focus();
	}
});

function result(
	url: string,
	title: string,
	layer: string,
	version: string,
	excerpt: string,
): HTMLAnchorElement {
	const link = document.createElement("a");
	link.className = "search-result";
	link.href = url;
	const metadata = document.createElement("small");
	metadata.textContent = `${layer} · ${version}`;
	const heading = document.createElement("strong");
	heading.textContent = title;
	const copy = document.createElement("span");
	const decoder = document.createElement("textarea");
	decoder.innerHTML = excerpt;
	copy.textContent = decoder.value;
	link.append(metadata, heading, copy);
	return link;
}

async function search(query: string, request: number): Promise<void> {
	try {
		reference ??= fetch("/reference.json").then(async (response) => {
			if (!response.ok) throw new Error("Reference index unavailable");
			return (await response.json()) as {
				version: string;
				symbols: Array<ReferenceSymbol>;
			};
		});
		const index = await reference;
		const exact = index.symbols
			.filter((symbol) => symbol.name.toLowerCase() === query.toLowerCase())
			.sort((a, b) => Number(b.name === query) - Number(a.name === query));
		const entries = exact.map((symbol) =>
			result(symbol.url, symbol.name, "API reference", index.version, symbol.description),
		);
		if (document.body.dataset.searchReady === "true") {
			const moduleUrl = "/pagefind/pagefind.js";
			pagefind ??= import(moduleUrl) as Promise<Pagefind>;
			const matches = await (await pagefind).search(query);
			const data = await Promise.all(
				matches.results.slice(0, 8).map(async (match) => await match.data()),
			);
			if (exact.length === 0 && /\s/.test(query))
				data.sort(
					(a, b) => Number(b.meta.layer === "Guides") - Number(a.meta.layer === "Guides"),
				);
			const urls = new Set(exact.map((symbol) => symbol.url));
			for (const item of data) {
				const sub = item.sub_results?.find((entry) => entry.url.includes("#"));
				const url = sub?.url ?? item.url;
				if (urls.has(url)) continue;
				urls.add(url);
				entries.push(
					result(
						url,
						item.meta.title
							? `${item.meta.title}${sub ? ` · ${sub.title}` : ""}`
							: "Documentation",
						item.meta.layer ?? "Docs",
						item.meta.version ?? index.version,
						sub?.plain_excerpt ?? item.plain_excerpt,
					),
				);
			}
		} else if (entries.length === 0) {
			entries.push(
				...index.symbols
					.filter((symbol) =>
						`${symbol.name} ${symbol.module} ${symbol.description}`
							.toLowerCase()
							.includes(query.toLowerCase()),
					)
					.slice(0, 8)
					.map((symbol) =>
						result(
							symbol.url,
							symbol.name,
							"API reference",
							index.version,
							symbol.description,
						),
					),
			);
		}
		if (request !== sequence) return;
		results.replaceChildren(...entries);
		status.textContent = entries.length
			? `${entries.length} ${entries.length === 1 ? "result" : "results"}${document.body.dataset.searchReady === "true" ? "" : " · Plain preview: symbol lookup only. Full search is built for the container."}`
			: "No results. Try a symbol name, or browse the API and troubleshooting links below.";
	} catch {
		if (request !== sequence) return;
		status.textContent =
			"Search is unavailable. Browse the API or troubleshooting below.";
		pagefind = undefined;
		reference = undefined;
	}
}
input.addEventListener("input", () => {
	clearTimeout(timer);
	const request = ++sequence;
	const query = input.value.trim();
	results.replaceChildren();
	if (!query) {
		status.textContent = "Search guides and API reference.";
		return;
	}
	status.textContent = "Searching…";
	timer = setTimeout(() => {
		void search(query, request);
	}, 150);
});

for (const button of document.querySelectorAll<HTMLButtonElement>(".copy-code")) {
	button.addEventListener("click", () => {
		void (async () => {
			const code =
				button.closest(".code-block")!.querySelector("code")!.textContent ?? "";
			try {
				await navigator.clipboard.writeText(code);
				button.textContent = "Copied";
				setTimeout(() => {
					button.textContent = "Copy";
				}, 1800);
			} catch {
				button.textContent = "Select code to copy";
			}
		})();
	});
}
