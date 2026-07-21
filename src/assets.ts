import { hash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { BuildConfigError } from "./build-config.ts";
import type { AssetInclusion } from "./build-config.ts";
import { legacyLocaleNameComparator, walkDirectoryTree } from "./file-tree.ts";

export const ASSET_FORMAT_VERSION = "1";
export const ASSET_COMPLETION_MARKER = ".maligator-asset-complete";

export interface IncludedAssetFile {
	/** Slash-separated path below the materialized asset root. */
	path: string;
	/** Absolute build-host path consumed by C23 `#embed`. */
	sourcePath: string;
	size: number;
	digest: string;
	/** Existing linked C byte-array symbol used instead of emitting another #embed. */
	embeddedSymbol?: string;
}

export interface IncludedAsset {
	name: string;
	type: "file" | "directory";
	hash: string;
	version: string;
	files: Array<IncludedAssetFile>;
}

function assetError(name: string, message: string): never {
	throw new BuildConfigError(`assets.${name}: ${message}`);
}

function validatePattern(name: string, pattern: string): Array<string> {
	if (
		pattern.length === 0 ||
		pattern.includes("\\") ||
		pattern.includes("\0") ||
		pattern.startsWith("/")
	) {
		assetError(name, `invalid include pattern '${pattern}'`);
	}
	const segments = pattern.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		assetError(name, `invalid include pattern '${pattern}'`);
	}
	return segments;
}

function matchSegment(pattern: string, value: string): boolean {
	let p = 0;
	let v = 0;
	let star = -1;
	let retry = -1;
	while (v < value.length) {
		if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
			p++;
			v++;
		} else if (p < pattern.length && pattern[p] === "*") {
			star = p++;
			retry = v;
		} else if (star !== -1) {
			p = star + 1;
			v = ++retry;
		} else {
			return false;
		}
	}
	while (p < pattern.length && pattern[p] === "*") p++;
	return p === pattern.length;
}

function matchPath(pattern: Array<string>, value: Array<string>, p = 0, v = 0): boolean {
	if (p === pattern.length) return v === value.length;
	if (pattern[p] === "**") {
		return (
			matchPath(pattern, value, p + 1, v) ||
			(v < value.length && matchPath(pattern, value, p, v + 1))
		);
	}
	return (
		v < value.length &&
		matchSegment(pattern[p]!, value[v]!) &&
		matchPath(pattern, value, p + 1, v + 1)
	);
}

function fileRow(
	sourcePath: string,
	relativePath: string,
	stagingDirectory: string,
): IncludedAssetFile {
	const bytes = readFileSync(sourcePath);
	const digest = hash("sha256", bytes, "hex");
	mkdirSync(stagingDirectory, { recursive: true });
	// A PID-qualified snapshot avoids concurrent writers while guaranteeing that
	// #embed later observes the exact bytes whose digest and length were recorded.
	const snapshotPath = path.join(stagingDirectory, `${digest}-${process.pid}`);
	writeFileSync(snapshotPath, bytes);
	return {
		path: relativePath,
		sourcePath: snapshotPath,
		size: bytes.length,
		digest,
	};
}

function includeFile(
	name: string,
	sourcePath: string,
	stagingDirectory: string,
): Array<IncludedAssetFile> {
	const basename = path.basename(sourcePath);
	if (basename === ASSET_COMPLETION_MARKER) {
		assetError(name, `file name '${ASSET_COMPLETION_MARKER}' is reserved`);
	}
	return [fileRow(sourcePath, basename, stagingDirectory)];
}

function includeDirectory(
	name: string,
	sourcePath: string,
	config: Extract<AssetInclusion, { type: "directory" }>,
	stagingDirectory: string,
): Array<IncludedAssetFile> {
	const patterns = config.include.map((pattern) => validatePattern(name, pattern));
	const matched = patterns.map(() => false);
	const files: Array<IncludedAssetFile> = [];

	walkDirectoryTree(
		sourcePath,
		({ dirent, fullPath, relativeSegments }) => {
			if (!dirent.isFile()) {
				assetError(name, `unsupported non-regular file '${relativeSegments.join("/")}'`);
			}
			for (let index = 0; index < patterns.length; index++) {
				if (matchPath(patterns[index]!, relativeSegments)) matched[index] = true;
			}
			if (patterns.some((pattern) => matchPath(pattern, relativeSegments))) {
				const relativePath = relativeSegments.join("/");
				if (relativePath === ASSET_COMPLETION_MARKER) {
					assetError(name, `path '${ASSET_COMPLETION_MARKER}' is reserved`);
				}
				files.push(fileRow(fullPath, relativePath, stagingDirectory));
			}
		},
		legacyLocaleNameComparator,
	);
	for (let index = 0; index < matched.length; index++) {
		if (!matched[index]) {
			assetError(name, `include pattern '${config.include[index]}' matched no files`);
		}
	}
	return files;
}

/** Resolve and hash every configured asset from the project root. */
export function includeConfiguredAssets(
	assets: Record<string, AssetInclusion>,
	projectRoot: string = process.cwd(),
): Array<IncludedAsset> {
	const included: Array<IncludedAsset> = [];
	const temporaryDirectory =
		process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? "/tmp";
	const stagingDirectory = path.resolve(
		temporaryDirectory,
		"maligator-asset-inputs",
		String(process.pid),
	);
	for (const name of Object.keys(assets).sort()) {
		const config = assets[name]!;
		const sourcePath = path.resolve(projectRoot, config.path);
		let stats;
		try {
			const rootEntry = readdirSync(path.dirname(sourcePath), {
				withFileTypes: true,
			}).find((entry) => entry.name === path.basename(sourcePath));
			if (rootEntry !== undefined && !rootEntry.isFile() && !rootEntry.isDirectory()) {
				assetError(name, `'${sourcePath}' is not a regular file or directory`);
			}
			stats = statSync(sourcePath);
		} catch (error) {
			if (error instanceof BuildConfigError) throw error;
			assetError(name, `cannot read '${sourcePath}': ${(error as Error).message}`);
		}
		if (config.type === "file" && !stats.isFile()) {
			assetError(name, `'${sourcePath}' is not a regular file`);
		}
		if (config.type === "directory" && !stats.isDirectory()) {
			assetError(name, `'${sourcePath}' is not a directory`);
		}

		const files =
			config.type === "file"
				? includeFile(name, sourcePath, stagingDirectory)
				: includeDirectory(name, sourcePath, config, stagingDirectory);
		const digestInput = {
			version: ASSET_FORMAT_VERSION,
			type: config.type,
			files: files.map((file) => [file.path, file.size, file.digest]),
		};
		included.push({
			name,
			type: config.type,
			hash: hash("sha256", JSON.stringify(digestInput), "hex"),
			version: ASSET_FORMAT_VERSION,
			files,
		});
	}
	return included;
}
