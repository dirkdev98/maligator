import { parse } from "yaml";
import type { Test262Frontmatter } from "./types.ts";

export function extractFrontmatterFromSource(
	path: string,
	source: string,
): { frontmatter: Test262Frontmatter; source: string } {
	const match = source.match(/\/\*---([\s\S]*?)---\*\//);
	if (!match) return { frontmatter: {}, source };
	const frontMatterSource = match[1]!.trim().replace(/[\r\n]+/g, "\n");
	try {
		return {
			frontmatter: parse(frontMatterSource, { strict: false }) as Test262Frontmatter,
			source,
		};
	} catch (cause) {
		throw new Error(`Could not parse frontmatter for '${path}'.`, { cause });
	}
}
