import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import type { Test262File, Test262Frontmatter } from "./types.ts";

export function test262Checkout() {
	if (existsSync(path.join(TEST262_METADATA.path, ".git"))) {
		if (Math.random() < 0.1) {
			test262Log("Updating repository...");
			execSync(`git fetch origin`, {
				cwd: TEST262_METADATA.path,
				stdio: "ignore",
			});
		} else {
			test262Log("Assuming up to date repository...");
		}
	} else {
		test262Log("Cloning repository...");
		execSync(
			`git clone https://github.com/${TEST262_METADATA.repository} ${TEST262_METADATA.path}`,
			{ stdio: "ignore" },
		);
	}

	test262Log(`Checkout revision: ${TEST262_METADATA.sha}.`);
	execSync(`git checkout ${TEST262_METADATA.sha}`, {
		cwd: TEST262_METADATA.path,
		stdio: "ignore",
	});
}

export function test262ListFiles() {
	return glob(`test/**/*.js`, {
		cwd: TEST262_METADATA.path,
		exclude: ["**/*FIXTURE.js"],
	});
}

export async function test262CollectFiles(iterator: AsyncIterable<string>) {
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
