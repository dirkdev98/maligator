import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config-values.ts";
/* oxlint-disable import/no-commonjs -- The catalog names its public export array exports. */
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { documentationModel } from "../website/docs/model.ts";
import { renderDocumentation } from "../website/docs/render.ts";

function renderPage(url: string): string {
	const { pages, symbols } = documentationModel();
	return renderDocumentation(
		pages.find((page) => page.url === url)!,
		symbols,
		"test",
		"HEAD",
	);
}

function linkUrls(html: string): Array<string> {
	return Array.from(html.matchAll(/<a href="([^"]+)"/g), (match) => match[1]!);
}

describe("public documentation contracts", () => {
	it("documents the actual resolved build defaults", () => {
		const defaults = resolveBuildConfig({});
		const { symbols } = documentationModel();
		for (const symbol of symbols.filter(
			(entry) => entry.module === "@maligator/cli" && entry.default !== undefined,
		)) {
			let actual: unknown = defaults;
			for (const key of symbol.name.split("."))
				actual = (actual as Record<string, unknown>)[key];
			expect(actual, symbol.name).toEqual(JSON.parse(symbol.default!));
		}
	});
	it("exposes every public catalog export and excludes internal modules", () => {
		const { pages, symbols } = documentationModel();
		for (const module of PLATFORM_MODULES.filter((entry) => !entry.internal)) {
			const page = pages.find(
				(entry) => entry.url === `/api/${module.id.slice("maligator:".length)}`,
			)!;
			const html = renderDocumentation(page, symbols, "test", "HEAD");
			expect(page.title).toBe(module.id);
			for (const entry of module.exports) expect(html).toContain(`id="${entry.name}"`);
			const anchors = Array.from(html.matchAll(/id="([^"]+)"/g), (match) => match[1]);
			expect(new Set(anchors).size, module.id).toBe(anchors.length);
		}
		expect(symbols.some((entry) => entry.module.includes("internal"))).toBe(false);
		expect(symbols.find((entry) => entry.name === "WorkerPool.run")?.url).toBe(
			"/api/workers#WorkerPool.run",
		);
		expect(symbols.find((entry) => entry.name === "serveAsset")?.url).toBe(
			"/api/http#serveAsset",
		);
	});
	it("lists the same ordered guide and API groups in navigation and indexes", () => {
		const guideIndex = renderPage("/guides");
		const referenceIndex = renderPage("/api");
		const navigation = guideIndex.match(
			/<nav aria-label="Documentation topics">([\s\S]*?)<\/nav>/,
		)![1]!;
		const guideGroups = [
			"Start",
			"Build and ship",
			"Platform",
			"Workers",
			"C libraries",
			"Diagnose",
		];
		const referenceGroups = ["Configuration", "Modules"];
		expect(
			Array.from(
				navigation.matchAll(/role="group" aria-label="([^"]+)"/g),
				(match) => match[1],
			),
		).toEqual([...guideGroups, ...referenceGroups]);
		const guideArticle = guideIndex.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)![1]!;
		const headings = (html: string) =>
			Array.from(html.matchAll(/<h([23])\b[^>]*>(.*?)<\/h[23]>/g), ([, level, title]) => [
				level,
				title!.replace(/<[^>]+>/g, ""),
			]);
		expect(headings(guideArticle)).toEqual(
			guideGroups.map((label) => [label === "Workers" ? "3" : "2", label]),
		);
		const referenceArticle = referenceIndex.match(
			/<article\b[^>]*>([\s\S]*?)<\/article>/,
		)![1]!;
		expect(headings(referenceArticle).slice(0, referenceGroups.length)).toEqual(
			referenceGroups.map((label) => ["2", label]),
		);
		const guideLinks = (html: string) =>
			linkUrls(html).filter((url) => url.startsWith("/guides/"));
		const referenceLinks = (html: string) =>
			linkUrls(html).filter((url) => url.startsWith("/api/") && !url.includes("#"));
		expect(guideLinks(guideArticle)).toEqual(guideLinks(navigation));
		expect(referenceLinks(referenceArticle)).toEqual(referenceLinks(navigation));
	});
	it("continues the guide sequence across groups and leaves out compiler contributions", () => {
		const sequence = (url: string) =>
			renderPage(url).match(
				/<nav[^>]*aria-label="Guide sequence">([\s\S]*?)<\/nav>/,
			)?.[1];
		expect(linkUrls(sequence("/guides/testing")!)).toEqual([
			"/guides/development",
			"/guides/build-configuration",
		]);
		expect(linkUrls(sequence("/guides/build-configuration")!)).toEqual([
			"/guides/testing",
			"/guides/assets",
		]);
		expect(linkUrls(sequence("/guides/troubleshooting")!)).toEqual(["/guides/profiling"]);
		expect(sequence("/guides/contributing")).toBeUndefined();
		expect(
			linkUrls(renderPage("/docs").match(/<article\b[^>]*>([\s\S]*?)<\/article>/)![1]!),
		).toContain("/guides/contributing");
	});
	it("routes configuration and library contract symbols to their own pages", () => {
		const { pages, symbols } = documentationModel();
		const renderReference = (url: string) =>
			renderDocumentation(
				pages.find((page) => page.url === url)!,
				symbols,
				"test",
				"HEAD",
			);
		for (const [route, names] of [
			["/api/build", ["defineBuild", "engine.eval", "MaligatorFfiLibrary.contract"]],
			[
				"/api/library",
				[
					"defineLibrary",
					"MaligatorLibraryContract.headers",
					"MaligatorFfiHandle.destroy.success",
					"MaligatorFfiFieldFacts",
				],
			],
		] as const) {
			const html = renderReference(route);
			for (const name of names) {
				expect(
					symbols.filter((symbol) => symbol.name === name).map((symbol) => symbol.url),
				).toEqual([`${route}#${name}`]);
				expect(html).toContain(`id="${name}"`);
			}
		}
		expect(linkUrls(renderReference("/api/build"))).toContain(
			"/api/library#defineLibrary",
		);
	});
	it("uses the same maintained worker example in guides and reference", () => {
		const { pages, symbols } = documentationModel();
		const guide = pages.find((entry) => entry.url === "/guides/workers")!;
		const reference = pages.find((entry) => entry.url === "/api/workers")!;
		const html = renderDocumentation(guide, symbols, "test", "HEAD");
		expect(reference.markdown).toContain(
			guide.markdown.match(/```typescript pool.ts\n([\s\S]+?)\n```/)![1],
		);
		expect(html).toContain("pool.ts");
		expect(html).not.toContain('class="shiki');
		expect(html).toContain('data-search-ready="false"');
	});
	it("resolves links from declaration hovers to published pages and symbols", () => {
		const { pages, symbols } = documentationModel();
		for (const source of ["src/public-api.d.ts", "src/workers-api.d.ts"]) {
			for (const match of readFileSync(source, "utf8").matchAll(
				/https:\/\/maligator.ddv.tools([^\s*]+)/g,
			)) {
				const [route, anchor] = match[1]!.split("#");
				const page = pages.find((entry) => entry.url === route)!;
				expect(page, match[0]).toBeDefined();
				if (anchor)
					expect(renderDocumentation(page, symbols, "test", "HEAD")).toContain(
						`id="${anchor}"`,
					);
			}
		}
	});
});
