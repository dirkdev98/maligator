import { hash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";

export interface DirectoryTreeEntry {
	dirent: Dirent;
	fullPath: string;
	relativeSegments: Array<string>;
}

export type NameComparator = (left: string, right: string) => number;

export const lexicalNameComparator: NameComparator = (left, right) =>
	left < right ? -1 : left > right ? 1 : 0;

/** Preserve pre-refactor locale ordering while making collation ties deterministic. */
export const legacyLocaleNameComparator: NameComparator = (left, right) =>
	left.localeCompare(right) || lexicalNameComparator(left, right);

/** Visit every non-directory entry in deterministic depth-first order. */
export function walkDirectoryTree(
	directory: string,
	visit: (entry: DirectoryTreeEntry) => void,
	compareNames: NameComparator = lexicalNameComparator,
): void {
	const walk = (currentDirectory: string, relativeSegments: Array<string>): void => {
		const entries = readdirSync(currentDirectory, { withFileTypes: true }).sort((a, b) =>
			compareNames(a.name, b.name),
		);
		for (const dirent of entries) {
			const nextSegments = [...relativeSegments, dirent.name];
			const fullPath = path.join(currentDirectory, dirent.name);
			if (dirent.isDirectory()) walk(fullPath, nextSegments);
			else visit({ dirent, fullPath, relativeSegments: nextSegments });
		}
	};

	walk(directory, []);
}

export interface DirectoryTreeHashOptions {
	root: string;
	directories: Array<string>;
	include: (entry: Dirent) => boolean;
	prefix?: Array<string>;
	compareNames?: NameComparator;
}

/** Hash a NUL-framed stream of relative paths and per-file SHA-256 digests. */
export function hashDirectoryTrees(options: DirectoryTreeHashOptions): string {
	const parts = [...(options.prefix ?? [])];
	for (const directory of options.directories) {
		walkDirectoryTree(
			directory,
			({ dirent, fullPath }) => {
				if (!options.include(dirent)) return;
				parts.push(
					path.relative(options.root, fullPath),
					"\0",
					hash("sha256", readFileSync(fullPath), "hex"),
					"\0",
				);
			},
			options.compareNames,
		);
	}
	return hash("sha256", parts.join(""), "hex");
}
