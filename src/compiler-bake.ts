import { createHash, hash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileIdentity, settledFileIdentity } from "./artifact-store.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { emitRelocatableNativeOverlayTranslationUnits } from "./compiler/target/emit-program-image.ts";
import { serializeRuntimeImage } from "./compiler/target/program-image-codec.ts";
import type { ProgramImage } from "./compiler/target/program-image.ts";
import { hashDirectoryTrees } from "./file-tree.ts";
import { writeSourceChunks } from "./generated-source.ts";
import { relativeImportCone } from "./source-import-cone.ts";

const COMPILER_WIRE_CACHE = path.join(maligatorCacheDirectory(), "compiler-wire");
const SOURCE_MANIFEST = "artifact.json";
const COMPILER_NATIVE_TRANSLATION_UNIT_CODE_UNITS = 1024 * 1024;
// Smaller units confine an edit's recompilation; the maximum still admits large functions.
const COMPILER_NATIVE_TRANSLATION_UNIT_TARGET_CODE_UNITS = 512 * 1024;

/**
 * Type erasure runs over every compiler source before a bake, so the stripper is
 * part of the bake identity even though the compiler entrypoint never imports it.
 */
const TYPE_STRIPPER_MODULE = "compiler/frontend/compact-type-strip.ts";

/** Third-party packages whose pinned version can change the baked wire. */
const PINNED_COMPILER_DEPENDENCIES = ["meriyah"];

interface CompilerBakeCacheInput {
	/** Compiler-wire cache root. Defaults to the compiler project's cache. */
	cacheRoot?: string;
}

export type CompilerBakeInput =
	| (CompilerBakeCacheInput & {
			kind: "source";
			/** Absolute compiler source directory. */
			sourceDirectory: string;
			/** Absolute source entrypoint compiled by bake. */
			entrypoint: string;
			/** Called only when this source identity has no valid cached wire. */
			bake: () => Uint8Array;
			/** Produces the wire and its reusable relocation-aware native companion together. */
			bakeProgram?: () => ProgramImage;
	  })
	| (CompilerBakeCacheInput & {
			kind: "bytes";
			bytes: Uint8Array;
	  })
	| (CompilerBakeCacheInput & {
			kind: "prebuilt";
			/** Absolute path to a prebuilt compiler wire. */
			path: string;
	  });

interface SourceManifest {
	schema: 2;
	sourceKey: string;
	outputDigest: string;
	native?: {
		key: string;
		digest: string;
		files: Array<string>;
	};
}

export interface CompilerArtifacts {
	wirePath: string;
	wireDigest: string;
	nativeSourcePaths: Array<string>;
	nativeDigest?: string;
}

function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function isCompilerSource(name: string): boolean {
	return [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].some((suffix) =>
		name.endsWith(suffix),
	);
}

function requireAbsolute(description: string, value: string): string {
	if (!path.isAbsolute(value)) {
		throw new Error(`${description} must be absolute: ${value}`);
	}
	return value;
}

function compilerDependencyIdentity(sourceDirectory: string): string {
	const packagePath = path.join(sourceDirectory, "..", "package.json");
	const manifest = JSON.parse(readFileSync(packagePath, "utf-8")) as {
		dependencies?: Record<string, unknown>;
	};
	const parts: Array<string> = [];
	for (const name of PINNED_COMPILER_DEPENDENCIES) {
		const version = manifest.dependencies?.[name];
		if (typeof version !== "string" || version.length === 0) {
			throw new Error(`compiler package does not pin ${name}: ${packagePath}`);
		}
		parts.push(name, "\0", version, "\0");
	}
	return parts.join("");
}

function isWithin(directory: string, target: string): boolean {
	const relative = path.relative(directory, target);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

/** Identity of the compiler source cone a bake compiles, memoized under file stats in `root`. */
function compilerSourceHash(
	root: string,
	sourceDirectory: string,
	entrypoint: string,
): string {
	if (!isWithin(sourceDirectory, entrypoint)) {
		throw new Error(`compiler entrypoint is outside source directory: ${entrypoint}`);
	}
	const relativeEntrypoint = path.relative(sourceDirectory, entrypoint);
	const checkoutKey = hash("sha256", `${sourceDirectory}\0${relativeEntrypoint}`, "hex");
	const cone = relativeImportCone(
		sourceDirectory,
		[relativeEntrypoint, TYPE_STRIPPER_MODULE],
		// Hidden so cache pruning, which keeps only the newest wires, never counts it as one.
		path.join(root, ".source-cones", `${checkoutKey.slice(0, 20)}.json`),
	);
	return hash(
		"sha256",
		[
			"compiler-source-files-v1\0",
			compilerDependencyIdentity(sourceDirectory),
			"entrypoint\0",
			relativeEntrypoint,
			"\0",
			...cone.flatMap(([file, digest]) => [file, "\0", digest, "\0"]),
		].join(""),
		"hex",
	);
}

function compilerNativeSourceKey(
	sourceDirectory: string,
	sourceIdentity: string,
): string {
	return hashDirectoryTrees({
		root: sourceDirectory,
		directories: [path.join(sourceDirectory, "compiler")],
		include: (entry) => isCompilerSource(entry.name),
		prefix: [
			"compiler-native-overlay-v4\0",
			String(COMPILER_NATIVE_TRANSLATION_UNIT_CODE_UNITS),
			"\0",
			String(COMPILER_NATIVE_TRANSLATION_UNIT_TARGET_CODE_UNITS),
			"\0",
			sourceIdentity,
			"\0",
		],
		compareNames,
	});
}

function compilerSourceArtifactKey(
	sourceIdentity: string,
	nativeKey: string | undefined,
): string {
	return hash(
		"sha256",
		[
			"compiler-source-artifacts-v2",
			nativeKey === undefined ? "portable-wire" : "native-overlay",
			sourceIdentity,
			nativeKey ?? "",
		].join("\0"),
		"hex",
	);
}

function cacheRoot(input: CompilerBakeInput): string {
	if (input.cacheRoot !== undefined) {
		return requireAbsolute("compiler-wire cache root", input.cacheRoot);
	}
	return COMPILER_WIRE_CACHE;
}

function cacheDirectory(root: string, key: string): string {
	return path.join(root, key);
}

function cachedWire(root: string, key: string): string {
	return path.join(cacheDirectory(root, key), "compiler.malw");
}

function fileDigest(filePath: string): string | undefined {
	try {
		const stats = statSync(filePath);
		if (!stats.isFile() || stats.size === 0) return undefined;
		return hash("sha256", readFileSync(filePath), "hex");
	} catch {
		return undefined;
	}
}

function validContentWire(root: string, digest: string): boolean {
	return fileDigest(cachedWire(root, digest)) === digest;
}

function sourceManifest(root: string, sourceKey: string): SourceManifest | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(path.join(cacheDirectory(root, sourceKey), SOURCE_MANIFEST), "utf-8"),
		) as Partial<SourceManifest>;
		if (
			manifest.schema === 2 &&
			manifest.sourceKey === sourceKey &&
			typeof manifest.outputDigest === "string" &&
			fileDigest(cachedWire(root, sourceKey)) === manifest.outputDigest
		) {
			return manifest as SourceManifest;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// Every eval-enabled build revalidates the overlay; hashing bytes avoids decoding ~100 MB.
function nativeArtifactDigest(files: ReadonlyArray<string>): string {
	const digest = createHash("sha256");
	const buffer = Buffer.allocUnsafe(256 * 1024);
	for (const file of files) {
		digest.update(`${String(statSync(file).size)}\0`);
		const descriptor = openSync(file, "r");
		try {
			for (;;) {
				const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
				if (bytes === 0) break;
				digest.update(buffer.subarray(0, bytes));
			}
		} finally {
			closeSync(descriptor);
		}
		digest.update("\0");
	}
	return digest.digest("hex");
}

// A process validates the eval compiler's 40 MiB overlay source set for every build.
const hashedNativeSources = new Map<string, string>();

function validNativeSources(
	directory: string,
	native: NonNullable<SourceManifest["native"]>,
	key: string,
): boolean {
	if (native.key !== key || native.files.length === 0) return false;
	const memo = JSON.stringify([directory, native.digest, native.files]);
	try {
		const stats = native.files.map((name) => statSync(path.join(directory, name)));
		const identity = JSON.stringify(stats.map(fileIdentity));
		if (hashedNativeSources.get(memo) === identity) return true;
		const hashedAt = Date.now();
		if (
			nativeArtifactDigest(native.files.map((name) => path.join(directory, name))) !==
			native.digest
		)
			return false;
		if (stats.every((entry) => settledFileIdentity(entry, hashedAt)))
			hashedNativeSources.set(memo, identity);
		return true;
	} catch {
		return false;
	}
}

function publishFile(
	directory: string,
	name: string,
	bytes: Uint8Array | string | ReadonlyArray<string>,
): void {
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	try {
		const temporaryPath = path.join(temporaryDirectory, name);
		if (typeof bytes === "string" || bytes instanceof Uint8Array)
			writeFileSync(temporaryPath, bytes);
		else writeSourceChunks(temporaryPath, bytes);
		renameSync(temporaryPath, path.join(directory, name));
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function requireNonemptyWire(bytes: Uint8Array): void {
	if (bytes.byteLength === 0) throw new Error("compiler wire must not be empty");
}

function ensureContentWire(root: string, bytes: Uint8Array): string {
	requireNonemptyWire(bytes);
	const digest = hash("sha256", bytes, "hex");
	const wirePath = cachedWire(root, digest);
	if (!validContentWire(root, digest)) {
		publishFile(cacheDirectory(root, digest), path.basename(wirePath), bytes);
	}
	if (!validContentWire(root, digest)) {
		throw new Error(`failed to publish compiler wire: ${wirePath}`);
	}
	return wirePath;
}

function ensureSourceArtifacts(
	root: string,
	sourceKey: string,
	bake: () => Uint8Array,
	bakeProgram: (() => ProgramImage) | undefined,
	nativeKey: string | undefined,
): CompilerArtifacts {
	const wirePath = cachedWire(root, sourceKey);
	const directory = cacheDirectory(root, sourceKey);
	const current = sourceManifest(root, sourceKey);
	if (
		current !== undefined &&
		(bakeProgram === undefined ||
			(nativeKey !== undefined &&
				current.native !== undefined &&
				validNativeSources(directory, current.native, nativeKey)))
	) {
		// CI native cache lines carry the bakes a job used, as recorded by this time.
		try {
			const now = new Date();
			utimesSync(path.join(directory, SOURCE_MANIFEST), now, now);
		} catch {
			// A read-only cache still serves the bake.
		}
		return {
			wirePath,
			wireDigest: current.outputDigest,
			nativeSourcePaths:
				current.native?.files.map((name) => path.join(directory, name)) ?? [],
			...(current.native === undefined ? {} : { nativeDigest: current.native.digest }),
		};
	}

	let bytes: Uint8Array;
	let native: SourceManifest["native"];
	if (bakeProgram === undefined) {
		bytes = bake();
	} else {
		if (nativeKey === undefined) {
			throw new Error("native compiler bake requires a native cache identity");
		}
		const image = bakeProgram();
		bytes = serializeRuntimeImage(image.runtime);
		requireNonemptyWire(bytes);
		const outputDigest = hash("sha256", bytes, "hex");
		if (current !== undefined && current.outputDigest !== outputDigest) {
			throw new Error(
				`cached compiler wire disagrees with native compiler program: ${wirePath}`,
			);
		}
		const units = emitRelocatableNativeOverlayTranslationUnits(
			image,
			outputDigest,
			COMPILER_NATIVE_TRANSLATION_UNIT_CODE_UNITS,
			COMPILER_NATIVE_TRANSLATION_UNIT_TARGET_CODE_UNITS,
		);
		const files = units.map((unit) => `compiler-${unit.id}.c`);
		for (const [index, unit] of units.entries()) {
			publishFile(directory, files[index]!, unit.sourceChunks);
		}
		native = {
			key: nativeKey,
			digest: nativeArtifactDigest(files.map((name) => path.join(directory, name))),
			files,
		};
	}
	requireNonemptyWire(bytes);
	const outputDigest = hash("sha256", bytes, "hex");
	publishFile(directory, path.basename(wirePath), bytes);
	const manifest: SourceManifest = { schema: 2, sourceKey, outputDigest, ...{ native } };
	if (native === undefined) delete manifest.native;
	publishFile(directory, SOURCE_MANIFEST, `${JSON.stringify(manifest)}\n`);
	const published = sourceManifest(root, sourceKey);
	if (
		published === undefined ||
		(native !== undefined &&
			(nativeKey === undefined || !validNativeSources(directory, native, nativeKey)))
	) {
		throw new Error(`failed to publish compiler wire: ${wirePath}`);
	}
	return {
		wirePath,
		wireDigest: outputDigest,
		nativeSourcePaths: native?.files.map((name) => path.join(directory, name)) ?? [],
		...(native === undefined ? {} : { nativeDigest: native.digest }),
	};
}

/** Ensure the requested eval compiler wire is present in the reusable cache. */
export function ensureCompilerWire(input: CompilerBakeInput): string {
	return ensureCompilerArtifacts(input).wirePath;
}

/** Ensure the eval compiler wire and its optional native companion are reusable. */
export function ensureCompilerArtifacts(input: CompilerBakeInput): CompilerArtifacts {
	const root = cacheRoot(input);
	if (input.kind === "prebuilt") {
		const wirePath = ensureContentWire(
			root,
			readFileSync(requireAbsolute("prebuilt compiler wire path", input.path)),
		);
		return {
			wirePath,
			wireDigest: fileDigest(wirePath)!,
			nativeSourcePaths: [],
		};
	}
	if (input.kind === "bytes") {
		const wirePath = ensureContentWire(root, input.bytes);
		return {
			wirePath,
			wireDigest: fileDigest(wirePath)!,
			nativeSourcePaths: [],
		};
	}

	const sourceDirectory = requireAbsolute(
		"compiler source directory",
		input.sourceDirectory,
	);
	const entrypoint = requireAbsolute("compiler source entrypoint", input.entrypoint);
	const sourceIdentity = compilerSourceHash(root, sourceDirectory, entrypoint);
	const nativeKey =
		input.bakeProgram === undefined
			? undefined
			: compilerNativeSourceKey(sourceDirectory, sourceIdentity);
	const sourceKey = compilerSourceArtifactKey(sourceIdentity, nativeKey);
	return ensureSourceArtifacts(root, sourceKey, input.bake, input.bakeProgram, nativeKey);
}
