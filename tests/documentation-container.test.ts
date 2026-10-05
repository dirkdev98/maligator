import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	documentationManifest,
	validateDocumentationLinks,
} from "../scripts/generate-documentation.ts";
import { prepareContainerDocumentation } from "../scripts/prepare-site-container.ts";

function decodedCode(html: string): Array<string> {
	return Array.from(html.matchAll(/<pre[^>]*>([\s\S]+?)<\/pre>/g), (match) =>
		match[1]!
			.replace(/<[^>]+>/g, "")
			.replace(/&#(x[\da-f]+|\d+);/gi, (_match, value: string) =>
				String.fromCodePoint(
					value.startsWith("x") ? Number.parseInt(value.slice(1), 16) : Number(value),
				),
			)
			.replaceAll("&quot;", '"')
			.replaceAll("&#39;", "'")
			.replaceAll("&#x27;", "'")
			.replaceAll("&gt;", ">")
			.replaceAll("&lt;", "<")
			.replaceAll("&amp;", "&"),
	);
}

it("prepares container-only search and highlighting without changing sources or code", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "maligator-documentation-"));
	const plain = path.join(directory, "plain");
	const output = path.join(directory, "container");
	const inputs = readdirSync("website", { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));
	const identity = (file: string) =>
		createHash("sha256").update(readFileSync(file)).digest("hex");
	const before = inputs.map(identity);
	try {
		await prepareContainerDocumentation(plain, output);
		expect(inputs.map(identity)).toEqual(before);
		const plainAssets = documentationManifest(plain);
		const processedAssets = documentationManifest(output);
		expect(plainAssets.some((asset) => asset.url.startsWith("/pagefind/"))).toBe(false);
		expect(processedAssets.some((asset) => asset.url === "/pagefind/pagefind.js")).toBe(
			true,
		);
		expect(processedAssets.some((asset) => asset.file.startsWith("pagefind/wasm."))).toBe(
			true,
		);
		for (const asset of plainAssets) {
			const original = readFileSync(path.join(plain, asset.file), "utf8");
			const processed = readFileSync(path.join(output, asset.file), "utf8");
			if (asset.file.endsWith(".html")) {
				expect(original).not.toContain('class="shiki');
				expect(processed).toContain('data-search-ready="true"');
				expect(decodedCode(processed), asset.url).toEqual(decodedCode(original));
			} else expect(processed, asset.url).toBe(original);
		}
		const manifest: unknown = JSON.parse(
			readFileSync(path.join(output, "manifest.json"), "utf8"),
		);
		expect(manifest).toEqual(processedAssets);
		validateDocumentationLinks(output);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
