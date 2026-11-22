import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import { imageUsesUrlParser } from "../src/native-host-components.ts";

function withoutCommentsAndLiterals(source: string): string {
	return source.replaceAll(
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
		" ",
	);
}

it("selects Ada for installers in C translation units that reference its ABI", () => {
	const runtime = path.resolve(import.meta.dirname, "../runtime");
	const header = withoutCommentsAndLiterals(
		readFileSync(path.join(runtime, "rust/include/mal_url.h"), "utf8"),
	);
	const symbols = new Set(
		Array.from(header.matchAll(/\bmal_url_\w+(?=\s*\()/g), ([symbol]) => symbol),
	);
	expect(symbols.size).toBeGreaterThan(0);

	const missing: Array<string> = [];
	const sources = readdirSync(path.join(runtime, "src"), {
		recursive: true,
		withFileTypes: true,
	});
	for (const entry of sources) {
		if (!entry.isFile() || !entry.name.endsWith(".c")) continue;
		const file = path.join(entry.parentPath, entry.name);
		const source = withoutCommentsAndLiterals(readFileSync(file, "utf8"));
		const referencesAda = source
			.match(/\b(?:mal_url|ada)_\w+\b/g)
			?.some((symbol) => symbols.has(symbol) || symbol.startsWith("ada_"));
		if (!referencesAda) continue;

		const installers = [
			...Array.from(
				source.matchAll(/\bvoid\s+(mal_host_install_\w+)\s*\([^)]*\)\s*\{/g),
				(match) => match[1]!,
			),
			...Array.from(
				source.matchAll(/^MAL_WEB_GROUP_DEFINE\(\s*(\w+)\s*,/gm),
				(match) => `mal_host_install_web_${match[1]}`,
			),
		];
		const relative = path.relative(runtime, file);
		if (installers.length === 0) {
			missing.push(`${relative} needs its Ada callers covered`);
		}
		for (const installer of installers) {
			if (!imageUsesUrlParser([{ installer, exports: [] }])) {
				missing.push(`${relative}:${installer}`);
			}
		}
	}
	expect(missing.sort()).toEqual([]);
});
