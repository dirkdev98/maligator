import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { documentationModel } from "../website/docs/model.ts";
import { renderDocumentation } from "../website/docs/render.ts";
import type { ExplorerAsset } from "../website/responses.ts";

export const PLAIN_DOCS = path.resolve(".cache/documentation/plain");
export const CONTAINER_DOCS = path.resolve(".cache/documentation/container");

export function validateDocumentationLinks(directory: string): void {
	const manifest = documentationManifest(directory);
	const documents = new Map(
		manifest
			.filter((asset) => asset.type.startsWith("text/html"))
			.map((asset) => [
				asset.url,
				readFileSync(path.join(directory, asset.file), "utf8"),
			]),
	);
	const routes = new Set([
		...manifest.map((asset) => asset.url),
		"/",
		"/explorer",
		"/compatibility",
		"/favicon.ico",
		"/favicon-32x32.png",
		"/apple-touch-icon.png",
	]);
	for (const [route, content] of documents) {
		for (const match of content.matchAll(/(?:href|src)="([^"\s]+)"/g)) {
			const target = new URL(
				match[1]!.replaceAll("&amp;", "&"),
				`https://maligator.ddv.tools${route}`,
			);
			if (target.origin !== "https://maligator.ddv.tools") continue;
			if (!routes.has(target.pathname))
				throw new Error(`Unknown documentation route: ${route} → ${target.pathname}`);
			const destination = documents.get(target.pathname);
			if (
				target.hash &&
				destination !== undefined &&
				!destination.includes(`id="${decodeURIComponent(target.hash.slice(1))}"`)
			)
				throw new Error(
					`Unknown documentation anchor: ${route} → ${target.pathname}${target.hash}`,
				);
		}
	}
}

export function documentationManifest(directory: string): Array<ExplorerAsset> {
	const types: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".md": "text/markdown; charset=utf-8",
		".json": "application/json",
		".js": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".wasm": "application/wasm",
		".txt": "text/plain; charset=utf-8",
	};
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name !== "manifest.json")
		.map((entry) => {
			const file = path
				.relative(directory, path.join(entry.parentPath, entry.name))
				.split(path.sep)
				.join("/");
			const body = readFileSync(path.join(directory, file));
			return {
				file,
				url: `/${file.replace(/\/index\.html$|\.html$/g, "")}`,
				type: types[path.extname(file)] ?? "application/octet-stream",
				bytes: body.length,
				digest: createHash("sha256").update(body).digest("hex"),
			};
		})
		.sort((a, b) => a.url.localeCompare(b.url));
}

export async function generateDocumentation(directory = PLAIN_DOCS): Promise<void> {
	const temporary = `${directory}-next-${process.pid}`;
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(temporary, { recursive: true });
	try {
		const { version } = JSON.parse(readFileSync("package.json", "utf8")) as {
			version: string;
		};
		const revision = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const { pages, symbols } = documentationModel();
		for (const page of pages) {
			const file = path.join(temporary, `${page.url.slice(1)}.html`);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, renderDocumentation(page, symbols, version, revision));
			const markdown = page.markdown.replace(
				/^(#{2,6}) (.+) \{#([^}]+)\}$/gm,
				'<a id="$3"></a>\n\n$1 $2',
			);
			writeFileSync(
				file.replace(/\.html$/, ".md"),
				`# ${page.title}\n\nMaligator ${version} · Experimental\nSource revision: ${revision}\nCanonical: https://maligator.ddv.tools${page.url}\n\n${markdown}`,
			);
		}
		writeFileSync(
			path.join(temporary, "reference.json"),
			`${JSON.stringify({ version, revision, symbols }, null, 2)}\n`,
		);
		writeFileSync(
			path.join(temporary, "llms.txt"),
			`# Maligator\n\nExperimental ahead-of-time JavaScript compiler and native runtime. Version ${version}, source ${revision}.\n\n## Documentation\n${pages.map((page) => `- [${page.title}](https://maligator.ddv.tools${page.url}.md): ${page.summary}`).join("\n")}\n\n## Symbols\n- [Public reference index](https://maligator.ddv.tools/reference.json): Signatures, defaults, availability, and canonical symbol URLs.\n`,
		);
		await build({
			input: "website/docs/client.ts",
			output: { file: path.join(temporary, "docs/assets/client.js"), format: "es" },
		});
		validateDocumentationLinks(temporary);
		writeFileSync(
			path.join(temporary, "manifest.json"),
			`${JSON.stringify(documentationManifest(temporary), null, 2)}\n`,
		);
		rmSync(directory, { recursive: true, force: true });
		renameSync(temporary, directory);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await generateDocumentation();
	console.log(PLAIN_DOCS);
}
