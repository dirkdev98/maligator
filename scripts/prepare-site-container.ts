import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Pagefind from "pagefind";
import type { Highlighter } from "shiki";
import {
	CONTAINER_DOCS,
	documentationManifest,
	generateDocumentation,
	PLAIN_DOCS,
} from "./generate-documentation.ts";

function assertNoErrors(result: { errors: Array<string> }): void {
	if (result.errors.length) throw new Error(result.errors.join("\n"));
}

export async function prepareContainerDocumentation(
	plain = PLAIN_DOCS,
	output = CONTAINER_DOCS,
): Promise<void> {
	await generateDocumentation(plain);
	const directory = `${output}-next-${process.pid}`;
	let highlighter: Highlighter | undefined;
	let pagefind: typeof Pagefind | undefined;
	try {
		rmSync(directory, { recursive: true, force: true });
		cpSync(plain, directory, { recursive: true });
		const { createHighlighter } = await import("shiki");
		pagefind = await import("pagefind");
		highlighter = await createHighlighter({
			themes: [
				{
					name: "maligator",
					type: "light",
					colors: { "editor.background": "#fffcf5", "editor.foreground": "#0b2c35" },
					settings: [
						{ scope: ["comment"], settings: { foreground: "#52666a" } },
						{ scope: ["keyword", "storage"], settings: { foreground: "#007e99" } },
						{ scope: ["string"], settings: { foreground: "#476b36" } },
						{
							scope: ["constant.numeric", "constant.language"],
							settings: { foreground: "#986017" },
						},
						{
							scope: ["entity.name.function", "support.function"],
							settings: { foreground: "#007e99" },
						},
					],
				},
			],
			langs: ["typescript", "javascript", "json", "shellscript"],
		});
		const created = await pagefind.createIndex({
			forceLanguage: "en",
			includeCharacters: "._-",
			writePlayground: false,
		});
		assertNoErrors(created);
		if (created.index === undefined) throw new Error("Pagefind did not create an index");
		for (const asset of documentationManifest(directory)) {
			if (!asset.file.endsWith(".html")) continue;
			const file = path.join(directory, asset.file);
			const contents = readFileSync(file, "utf8")
				.replace('data-search-ready="false"', 'data-search-ready="true"')
				.replace(
					/<pre data-language="([^"]+)"><code>([\s\S]*?)<\/code><\/pre>/g,
					(_match, language: string, escaped: string) => {
						const code = escaped
							.replaceAll("&quot;", '"')
							.replaceAll("&gt;", ">")
							.replaceAll("&lt;", "<")
							.replaceAll("&amp;", "&");
						const lang =
							(
								{ shell: "shellscript", sh: "shellscript", text: "text" } as Record<
									string,
									string
								>
							)[language] ?? language;
						return highlighter!.codeToHtml(code, { lang, theme: "maligator" });
					},
				);
			writeFileSync(file, contents);
			if (!["/docs", "/api", "/guides"].includes(asset.url)) {
				assertNoErrors(
					await created.index.addHTMLFile({ url: asset.url, content: contents }),
				);
			}
		}
		assertNoErrors(
			await created.index.writeFiles({ outputPath: path.join(directory, "pagefind") }),
		);
		writeFileSync(
			path.join(directory, "manifest.json"),
			`${JSON.stringify(documentationManifest(directory), null, 2)}\n`,
		);
		rmSync(output, { recursive: true, force: true });
		renameSync(directory, output);
	} finally {
		highlighter?.dispose();
		await pagefind?.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await prepareContainerDocumentation();
	console.log(CONTAINER_DOCS);
}
