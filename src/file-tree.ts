import { hash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	descend: (entry: DirectoryTreeEntry) => boolean = () => true,
): void {
	const walk = (currentDirectory: string, relativeSegments: Array<string>): void => {
		const entries = readdirSync(currentDirectory, { withFileTypes: true }).sort((a, b) =>
			compareNames(a.name, b.name),
		);
		for (const dirent of entries) {
			const nextSegments = [...relativeSegments, dirent.name];
			const fullPath = path.join(currentDirectory, dirent.name);
			const entry = { dirent, fullPath, relativeSegments: nextSegments };
			if (dirent.isDirectory()) {
				if (descend(entry)) walk(fullPath, nextSegments);
			} else visit(entry);
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
	descend?: (entry: DirectoryTreeEntry) => boolean;
}

interface CachedFileDigest {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	digest: string;
}

interface DirectoryTreeHashManifest {
	schema: 1;
	identity: string;
	root: string;
	files: Record<string, CachedFileDigest>;
}

export interface CachedDirectoryTreeHash {
	digest: string;
	reusedFiles: number;
	hashedFiles: number;
}

function readHashManifest(
	manifestPath: string,
	root: string,
	identity: string,
): DirectoryTreeHashManifest | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(manifestPath, "utf-8"),
		) as DirectoryTreeHashManifest;
		if (
			manifest.schema !== 1 ||
			manifest.root !== root ||
			manifest.identity !== identity ||
			typeof manifest.files !== "object" ||
			manifest.files === null
		) {
			return undefined;
		}
		return manifest;
	} catch {
		return undefined;
	}
}

function publishHashManifest(
	manifestPath: string,
	manifest: DirectoryTreeHashManifest,
): void {
	const parent = path.dirname(manifestPath);
	mkdirSync(parent, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(parent, ".digest-"));
	try {
		const temporaryPath = path.join(temporaryDirectory, "manifest.json");
		writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`);
		renameSync(temporaryPath, manifestPath);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
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
			options.descend,
		);
	}
	return hash("sha256", parts.join(""), "hex");
}

/** Persist per-file digests and only reread files whose stable stat identity changed. */
export function hashDirectoryTreesCached(
	options: DirectoryTreeHashOptions,
	manifestPath: string,
	identity: string,
): CachedDirectoryTreeHash {
	const root = path.resolve(options.root);
	const previous = readHashManifest(manifestPath, root, identity);
	const files: Record<string, CachedFileDigest> = {};
	const parts = [...(options.prefix ?? [])];
	let reusedFiles = 0;
	let hashedFiles = 0;
	for (const directory of options.directories) {
		walkDirectoryTree(
			directory,
			({ dirent, fullPath }) => {
				if (!options.include(dirent)) return;
				const relativePath = path.relative(root, fullPath);
				const stats = statSync(fullPath);
				const cached = previous?.files[relativePath];
				const unchanged =
					cached !== undefined &&
					typeof cached.digest === "string" &&
					/^[0-9a-f]{64}$/.test(cached.digest) &&
					cached.size === stats.size &&
					cached.mtimeMs === stats.mtimeMs &&
					cached.ctimeMs === stats.ctimeMs &&
					cached.ino === stats.ino;
				const digest = unchanged
					? cached.digest
					: hash("sha256", readFileSync(fullPath), "hex");
				if (unchanged) reusedFiles++;
				else hashedFiles++;
				files[relativePath] = {
					size: stats.size,
					mtimeMs: stats.mtimeMs,
					ctimeMs: stats.ctimeMs,
					ino: stats.ino,
					digest,
				};
				parts.push(relativePath, "\0", digest, "\0");
			},
			options.compareNames,
			options.descend,
		);
	}
	if (
		hashedFiles > 0 ||
		previous === undefined ||
		Object.keys(previous.files).length !== Object.keys(files).length
	) {
		publishHashManifest(manifestPath, { schema: 1, identity, root, files });
	}
	return {
		digest: hash("sha256", parts.join(""), "hex"),
		reusedFiles,
		hashedFiles,
	};
}
