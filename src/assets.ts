import { hash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";
import { BuildConfigError } from "./build-config-error.ts";
import { EMBED_INSTALLER } from "./compiler/frontend/embed-declarations.ts";
import type {
	EmbedDeclaration,
	EmbeddedAsset,
} from "./compiler/frontend/embed-declarations.ts";
import { deserializeRuntimeImage } from "./compiler/target/program-image-codec.ts";
import type { RuntimeImage } from "./compiler/target/runtime-image.ts";
import { walkDirectoryTree } from "./file-tree.ts";
import type { FrontendCompilationSession } from "./frontend-cache.ts";

export const ASSET_FORMAT_VERSION = "2";
export const ASSET_COMPLETION_MARKER = ".maligator-asset-complete";

export interface IncludedAssetFile {
	/** Slash-separated path below the asset's directory, or the file name. */
	path: string;
	/** Absolute build-host path consumed by C23 `#embed`. */
	sourcePath: string;
	/** Original project input watched for changes. */
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
	/** The declaration's `name`, which the installer looks its embedded copy up by. */
	name: string;
	type: "file" | "directory";
	hash: string;
	version: string;
	files: Array<IncludedAssetFile>;
}

const installerName = new TextEncoder().encode(EMBED_INSTALLER);

/**
 * The embed declarations serialized images install. Most images declare none, so an
 * image is decoded only when its bytes name the installer.
 */
export function embedDeclarationsOfWires(
	wires: Iterable<Uint8Array>,
): Array<EmbedDeclaration> {
	const images = [];
	for (const wire of wires)
		if (
			Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength).includes(installerName)
		)
			images.push(deserializeRuntimeImage(wire));
	return embedDeclarationsOf(images);
}

/** The distinct embed declarations a set of images installs, in a stable order. */
export function embedDeclarationsOf(
	images: Iterable<Pick<RuntimeImage, "hostInstalls">>,
): Array<EmbedDeclaration> {
	const declarations = new Map<string, EmbedDeclaration>();
	for (const image of images)
		for (const install of image.hostInstalls) {
			if (install.installer !== EMBED_INSTALLER) continue;
			for (const entry of install.exports) {
				if (entry.data === undefined) continue;
				declarations.set(
					JSON.stringify(entry.data),
					entry.data as unknown as EmbedDeclaration,
				);
			}
		}
	return [...declarations]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, declaration]) => declaration);
}

function assetError(declaration: EmbeddedAsset, message: string): never {
	throw new BuildConfigError(
		`embedded ${declaration.kind} '${declaration.path}': ${message}`,
	);
}

/*
 * The pattern dialect the runtime matches live directories with
 * (runtime/src/runtime/maligator_assets.c): `*` and `?` within a segment and `**`
 * for whole segments. Without `dot`, a wildcard never matches a segment starting
 * with a dot, while a pattern segment that spells the dot does.
 */
function matchSegment(pattern: string, value: string, dot: boolean): boolean {
	if (!dot && value.startsWith(".") && !pattern.startsWith(".")) return false;
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

export function matchAssetPath(
	pattern: ReadonlyArray<string>,
	value: ReadonlyArray<string>,
	dot: boolean,
	p = 0,
	v = 0,
): boolean {
	if (p === pattern.length) return v === value.length;
	if (pattern[p] === "**") {
		return (
			matchAssetPath(pattern, value, dot, p + 1, v) ||
			(v < value.length &&
				(dot || !value[v]!.startsWith(".")) &&
				matchAssetPath(pattern, value, dot, p, v + 1))
		);
	}
	return (
		v < value.length &&
		matchSegment(pattern[p]!, value[v]!, dot) &&
		matchAssetPath(pattern, value, dot, p + 1, v + 1)
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
		// #embed must observe the complete bytes whose digest and length were recorded.
		snapshotPath = path.join(stagingDirectory, `${digest}-${process.pid}`);
		writeFileAtomically(snapshotPath, bytes!);
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

/** UTF-8 byte order, which is code point order and the order the runtime lists in. */
function compareMemberPaths(left: IncludedAssetFile, right: IncludedAssetFile): number {
	return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

function includeDirectory(
	declaration: EmbeddedAsset,
	stagingDirectory: string,
	options?: AssetCollectionOptions,
): Array<IncludedAssetFile> {
	const dot = declaration.dot === true;
	const include = (declaration.include ?? ["**"]).map((pattern) => pattern.split("/"));
	const exclude = (declaration.exclude ?? []).map((pattern) => pattern.split("/"));
	const matched = include.map(() => false);
	const files: Array<IncludedAssetFile> = [];

	walkDirectoryTree(declaration.path, ({ dirent, fullPath, relativeSegments }) => {
		let included = false;
		for (let index = 0; index < include.length; index++) {
			if (!matchAssetPath(include[index]!, relativeSegments, dot)) continue;
			matched[index] = true;
			included = true;
		}
		if (
			!included ||
			exclude.some((pattern) => matchAssetPath(pattern, relativeSegments, dot))
		)
			return;
		const relativePath = relativeSegments.join("/");
		if (!dirent.isFile())
			assetError(declaration, `'${relativePath}' is not a regular file`);
		if (relativePath === ASSET_COMPLETION_MARKER)
			assetError(declaration, `path '${ASSET_COMPLETION_MARKER}' is reserved`);
		files.push(fileRow(fullPath, relativePath, stagingDirectory, options));
	});
	if (declaration.include !== undefined)
		for (let index = 0; index < matched.length; index++) {
			if (!matched[index])
				assetError(
					declaration,
					`include pattern '${declaration.include[index]}' matched no files`,
				);
		}
	return files.sort(compareMemberPaths);
}

/** Read and hash the files of every embed declaration a build reaches. */
export function collectEmbeddedAssets(
	declarations: ReadonlyArray<EmbeddedAsset>,
	options?: AssetCollectionOptions,
): Array<IncludedAsset> {
	const temporaryDirectory =
		process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? "/tmp";
	const stagingDirectory = path.resolve(
		temporaryDirectory,
		"maligator-asset-inputs",
		String(process.pid),
	);
	return declarations.map((declaration) => {
		let stats;
		try {
			stats = lstatSync(declaration.path);
		} catch (error) {
			return assetError(declaration, `cannot read: ${(error as Error).message}`);
		}
		if (declaration.kind === "file" && !stats.isFile())
			assetError(declaration, "is not a regular file");
		if (declaration.kind === "directory" && !stats.isDirectory())
			assetError(declaration, "is not a directory");
		if (
			declaration.kind === "file" &&
			path.basename(declaration.path) === ASSET_COMPLETION_MARKER
		)
			assetError(declaration, `file name '${ASSET_COMPLETION_MARKER}' is reserved`);

		const files =
			declaration.kind === "file"
				? [
						fileRow(
							declaration.path,
							path.basename(declaration.path),
							stagingDirectory,
							options,
						),
					]
				: includeDirectory(declaration, stagingDirectory, options);
		const digestInput = {
			version: ASSET_FORMAT_VERSION,
			type: declaration.kind,
			files: files.map((file) => [file.path, file.size, file.digest]),
		};
		return {
			name: declaration.name,
			type: declaration.kind,
			hash: hash("sha256", JSON.stringify(digestInput), "hex"),
			version: ASSET_FORMAT_VERSION,
			files,
		};
	});
}
