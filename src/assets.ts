import { hash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { BuildConfigError } from "./build-config.ts";
import type { AssetInclusion } from "./build-config.ts";
import { legacyLocaleNameComparator, walkDirectoryTree } from "./file-tree.ts";
import type { FrontendCompilationSession } from "./frontend-cache.ts";

export const ASSET_FORMAT_VERSION = "1";
export const ASSET_COMPLETION_MARKER = ".maligator-asset-complete";

export interface IncludedAssetFile {
	/** Slash-separated path below the materialized asset root. */
	path: string;
	/** Absolute build-host path consumed by C23 `#embed`. */
	sourcePath: string;
	/** Original project input watched for development changes. */
	inputPath: string;
	size: number;
	digest: string;
	/** Existing linked C byte-array symbol used instead of emitting another #embed. */
	embeddedSymbol?: string;
}

export interface AssetCollectionOptions {
	cacheDirectory: string;
	session: FrontendCompilationSession;
}

interface AssetSnapshotManifest {
	schema: 1;
	digest: string;
	size: number;
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

function validSnapshot(
	file: string,
	manifestPath: string,
	digest: string,
	size: number,
): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(manifestPath, "utf-8"),
		) as AssetSnapshotManifest;
		if (manifest.schema !== 1 || manifest.digest !== digest || manifest.size !== size) {
			return false;
		}
		const stats = statSync(file);
		if (!stats.isFile() || stats.size !== manifest.size) return false;
		return hash("sha256", new Uint8Array(readFileSync(file)), "hex") === digest;
	} catch {
		return false;
	}
}

function cachedSnapshot(
	sourcePath: string,
	digest: string,
	size: number,
	cacheDirectory: string,
): string {
	const directory = path.resolve(cacheDirectory, "asset-files");
	const file = path.join(directory, `${digest}.bin`);
	const manifestPath = path.join(directory, `${digest}.json`);
	if (validSnapshot(file, manifestPath, digest, size)) return file;

	const bytes = new Uint8Array(readFileSync(sourcePath));
	if (bytes.length !== size || hash("sha256", bytes, "hex") !== digest) {
		throw new Error(`asset changed while it was being collected: ${sourcePath}`);
	}
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	try {
		const temporaryFile = path.join(temporaryDirectory, "asset.bin");
		writeFileSync(temporaryFile, bytes);
		renameSync(temporaryFile, file);
		const manifest: AssetSnapshotManifest = {
			schema: 1,
			digest,
			size,
		};
		const temporaryManifest = path.join(temporaryDirectory, "asset.json");
		writeFileSync(temporaryManifest, `${JSON.stringify(manifest)}\n`);
		renameSync(temporaryManifest, manifestPath);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	if (!validSnapshot(file, manifestPath, digest, size)) {
		throw new Error(`asset snapshot publication failed: ${file}`);
	}
	return file;
}

function fileRow(
	sourcePath: string,
	relativePath: string,
	stagingDirectory: string,
	options?: AssetCollectionOptions,
): IncludedAssetFile {
	const snapshot = options?.session.snapshot(sourcePath);
	const bytes =
		snapshot === undefined ? new Uint8Array(readFileSync(sourcePath)) : undefined;
	const digest = snapshot?.digest ?? hash("sha256", bytes!, "hex");
	const size = snapshot?.size ?? bytes!.length;
	let snapshotPath: string;
	if (options === undefined) {
		mkdirSync(stagingDirectory, { recursive: true });
		// A PID-qualified snapshot avoids concurrent writers while guaranteeing that
		// #embed later observes the exact bytes whose digest and length were recorded.
		snapshotPath = path.join(stagingDirectory, `${digest}-${process.pid}`);
		writeFileSync(snapshotPath, bytes!);
	} else {
		snapshotPath = cachedSnapshot(sourcePath, digest, size, options.cacheDirectory);
	}
	return {
		path: relativePath,
		sourcePath: snapshotPath,
		inputPath: sourcePath,
		size,
		digest,
	};
}

function includeFile(
	name: string,
	sourcePath: string,
	stagingDirectory: string,
	options?: AssetCollectionOptions,
): Array<IncludedAssetFile> {
	const basename = path.basename(sourcePath);
	if (basename === ASSET_COMPLETION_MARKER) {
		assetError(name, `file name '${ASSET_COMPLETION_MARKER}' is reserved`);
	}
	return [fileRow(sourcePath, basename, stagingDirectory, options)];
}

function includeDirectory(
	name: string,
	sourcePath: string,
	config: Extract<AssetInclusion, { type: "directory" }>,
	stagingDirectory: string,
	options?: AssetCollectionOptions,
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
				files.push(fileRow(fullPath, relativePath, stagingDirectory, options));
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
	options?: AssetCollectionOptions,
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
				? includeFile(name, sourcePath, stagingDirectory, options)
				: includeDirectory(name, sourcePath, config, stagingDirectory, options);
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
