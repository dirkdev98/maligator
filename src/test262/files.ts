import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import type { Test262File, Test262Frontmatter } from "./types.ts";

const TEST262_REMOTE = `https://github.com/${TEST262_METADATA.repository}`;

/** Materialize the exact Test262 revision selected by the repository. */
export function test262PrepareCheckout() {
	if (!existsSync(path.join(TEST262_METADATA.path, ".git"))) {
		test262Log("Cloning repository...");
		mkdirSync(TEST262_METADATA.path, { recursive: true });
		execFileSync("git", ["init"], {
			cwd: TEST262_METADATA.path,
			stdio: "ignore",
		});
		execFileSync("git", ["remote", "add", "origin", TEST262_REMOTE], {
			cwd: TEST262_METADATA.path,
			stdio: "ignore",
		});
	} else {
		// Preparation is the only command allowed to repair/fetch the corpus. Keep
		// it non-interactive even when an old cache was initialized with SSH.
		execFileSync("git", ["remote", "set-url", "origin", TEST262_REMOTE], {
			cwd: TEST262_METADATA.path,
			stdio: "ignore",
		});
	}

	try {
		execFileSync("git", ["cat-file", "-e", `${TEST262_METADATA.revision}^{commit}`], {
			cwd: TEST262_METADATA.path,
			stdio: "ignore",
		});
	} catch {
		test262Log(`Fetching pinned revision ${TEST262_METADATA.revision}...`);
		execFileSync("git", ["fetch", "--depth", "1", "origin", TEST262_METADATA.revision], {
			cwd: TEST262_METADATA.path,
			stdio: "ignore",
		});
	}
	execFileSync("git", ["checkout", "--detach", "--force", TEST262_METADATA.revision], {
		cwd: TEST262_METADATA.path,
		stdio: "ignore",
	});

	return test262Checkout();
}

/**
 * Validate the pinned full corpus without cloning, fetching, or changing its
 * checkout. Test commands are deliberately read-only cache consumers.
 */
export function test262Checkout() {
	if (!existsSync(path.join(TEST262_METADATA.path, ".git"))) {
		throw new Error(
			`Test262 corpus cache is missing at ${TEST262_METADATA.path}; run npm run test262:prepare`,
		);
	}

	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: TEST262_METADATA.path,
		encoding: "utf-8",
	}).trim();
	if (sha !== TEST262_METADATA.revision) {
		throw new Error(
			`Test262 corpus cache is ${sha}; expected ${TEST262_METADATA.revision}; run npm run test262:prepare`,
		);
	}
	test262Log(`Revision: ${sha}.`);

	return sha;
}

export function test262ListFiles() {
	return execFileSync("git", ["ls-files", "-z", "--", "test"], {
		cwd: TEST262_METADATA.path,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	})
		.split("\0")
		.filter((file) => file.endsWith(".js") && !file.endsWith("FIXTURE.js"))
		.sort();
}

export async function test262CollectFiles(
	iterator: Iterable<string> | AsyncIterable<string>,
) {
	const files: Array<Test262File> = [];
	for await (const file of iterator) {
		const contents = await readFile(path.join(TEST262_METADATA.path, file), "utf-8");
		const { source, frontmatter } = extractFrontmatterFromSource(file, contents);
		files.push({
			frontmatter,
			path: file,
			content: source,
			result: "UNKNOWN",
		});
	}

	files.sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	test262Log(`Loaded ${files.length} files.`);

	return files;
}

function extractFrontmatterFromSource(
	path: string,
	source: string,
): {
	frontmatter: Test262Frontmatter;
	source: string;
} {
	const yamlRegex = /\/\*---([\s\S]*?)---\*\//;
	const match = source.match(yamlRegex);

	if (!match) {
		return { frontmatter: {}, source };
	}

	const frontMatterSource = match[1]!.trim().replace(/[\r\n]+/g, "\n");

	try {
		const strippedSource = source.replace(yamlRegex, "");
		const frontmatter = parse(frontMatterSource, {
			strict: false,
		}) as Test262Frontmatter;

		return {
			frontmatter,
			source: strippedSource,
		};
	} catch (e) {
		// @ts-expect-error add some context to the error.
		e.source = frontMatterSource;
		throw new Error(`Could not parse frontmatter for '${path}'.`, {
			cause: e,
		});
	}
}
