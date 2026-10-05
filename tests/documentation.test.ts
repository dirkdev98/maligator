import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config-values.ts";
/* oxlint-disable import/no-commonjs -- The catalog names its public export array exports. */
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { documentationModel } from "../website/docs/model.ts";
import { renderDocumentation } from "../website/docs/render.ts";

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
			for (const entry of module.exports) expect(html).toContain(`id="${entry.name}"`);
			const anchors = Array.from(html.matchAll(/id="([^"]+)"/g), (match) => match[1]);
			expect(new Set(anchors).size, module.id).toBe(anchors.length);
		}
		expect(symbols.some((entry) => entry.module.includes("internal"))).toBe(false);
		expect(symbols.find((entry) => entry.name === "WorkerPool.run")?.url).toBe(
			"/api/workers#WorkerPool.run",
		);
		expect(symbols.find((entry) => entry.name === "engine.eval")?.url).toBe(
			"/api/build#engine.eval",
		);
		for (const name of ["mal", "Mal"])
			expect(symbols.find((entry) => entry.name === name)?.url).toBe(
				`/api/runtime#${name}`,
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
