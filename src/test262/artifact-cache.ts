import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

/**
 * Content-addressed cache for the expensive build artifact in the test262
 * pipeline: each batch's compiled object file (`.o`). Compiling the generated C
 * is ~97% of a batch's `cc` time (linking is ~3%), and the generated C is a pure
 * function of (test sources + harness + the TypeScript compiler + the runtime
 * headers). So when only the runtime *implementation* (`.c` files) changes - the
 * common edit/re-run loop - every batch's C is byte-identical and its `.o` can be
 * reused; we only re-link against the freshly built library.
 *
 * Correctness rests entirely on the cache key being conservative: it folds in a
 * fingerprint of the whole compiler (`src/**`) and of every runtime header
 * (`runtime/src/**.h`) plus the cc flags and version, so any change that could
 * alter the emitted `.o` changes the key. Run results are never cached - we
 * always execute the binary - so flakes and behavioural changes still surface.
 */

// Each pass (T262_VARIANT) keeps its own cache so the strict and sloppy builds
// never collide: their composed source is byte-identical (the strict pass adds no
// `"use strict"` directive - strictness flows through the parser), so a shared
// cache would alias the two different `.o`s under one key. Read lazily: the
// variant env var is set by runVariant() after this module is imported.
function cacheDir(): string {
	return process.env.T262_VARIANT
		? `.cache/test262-artifacts-${process.env.T262_VARIANT}`
		: ".cache/test262-artifacts";
}

/**
 * Per-batch manifest stored alongside the `.o`. It captures everything the
 * compile phase produced so a cache hit can reconstruct the exact same run
 * verdicts, failure buckets and code-size stats without re-compiling.
 */
export interface BatchManifest {
	hasBinary: boolean;
	/** Tests that produced C, in driver index order. */
	entries: Array<{ path: string; index: number }>;
	/** Tests resolved during compile (skipped / unsupported / compile-failed). */
	resolved: Array<{
		path: string;
		result: string;
		unsupported?: Array<string>;
		failure?: string;
	}>;
	stats: {
		compiledFiles: number;
		functionCount: number;
		instructionCount: number;
		opcodes: Record<string, number>;
	};
}

function hashDirectory(
	hash: ReturnType<typeof createHash>,
	dir: string,
	extensions: Array<string>,
) {
	if (!existsSync(dir)) {
		return;
	}

	const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(
			(entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)),
		)
		// `recursive` ordering is platform-dependent; sort for a stable fingerprint.
		.map((entry) => path.join(entry.parentPath, entry.name))
		.sort();

	for (const file of entries) {
		hash.update(file);
		hash.update(readFileSync(file));
	}
}

let cachedFingerprint: string | undefined;

/**
 * A stable hash of every input that can change a batch's `.o`: the whole
 * compiler (`src/**.ts`), every runtime header, and the cc flags/version. The
 * runtime `.c` files are deliberately excluded - they compile into the library
 * we always re-link, not into the batch object - which is exactly what makes the
 * implementation-edit loop a cache hit.
 */
export function buildFingerprint(ccFlags: Array<string>): string {
	if (cachedFingerprint !== undefined) {
		return cachedFingerprint;
	}

	const hash = createHash("sha256");
	hash.update("v1\n");
	hashDirectory(hash, "src", [".ts"]);
	hashDirectory(hash, "runtime/src", [".h"]);
	hash.update(ccFlags.join(" "));

	try {
		hash.update(execSync("cc --version", { encoding: "utf-8" }));
	} catch {
		// Best effort; the flags + headers already capture most of the ABI surface.
	}

	cachedFingerprint = hash.digest("hex");
	return cachedFingerprint;
}

/**
 * Key a batch by its build fingerprint, the emit mode (shared-harness changes
 * the generated C, hence the object), and the composed source of every test in
 * it (harness + host prelude + test body). Composition order is deterministic,
 * so identical inputs always yield the same key.
 */
export function batchCacheKey(
	fingerprint: string,
	emitMode: string,
	composedSources: Array<string>,
): string {
	const hash = createHash("sha256");
	hash.update(fingerprint);
	hash.update("\n");
	hash.update(emitMode);
	hash.update("\n");
	for (const source of composedSources) {
		hash.update(String(source.length));
		hash.update(":");
		hash.update(source);
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function cacheEnabled(): boolean {
	return process.env.T262_OBJCACHE !== "0";
}

export function ensureCacheDir() {
	mkdirSync(cacheDir(), { recursive: true });
}

/**
 * Where a batch's object file lives. The compiler writes straight here on a
 * miss (no copy), and the linker reads from here on a hit.
 */
export function objectCachePath(key: string) {
	return path.join(cacheDir(), `${key}.o`);
}

function manifestPath(key: string) {
	return path.join(cacheDir(), `${key}.json`);
}

export interface CachedArtifact {
	objectPath: string | undefined;
	manifest: BatchManifest;
}

/**
 * Return the cached artifact for a key, or undefined on a miss. A batch whose
 * tests were all resolved at compile time has a manifest but no `.o`.
 */
export function loadArtifact(key: string): CachedArtifact | undefined {
	const manifestFile = manifestPath(key);
	if (!existsSync(manifestFile)) {
		return undefined;
	}

	let manifest: BatchManifest;
	try {
		manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as BatchManifest;
	} catch {
		return undefined;
	}

	if (manifest.hasBinary && !existsSync(objectCachePath(key))) {
		return undefined;
	}

	return {
		objectPath: manifest.hasBinary ? objectCachePath(key) : undefined,
		manifest,
	};
}

/**
 * Record the manifest for a key. The object file (if any) is compiled straight
 * into {@link objectCachePath}, so this only needs to publish the metadata - and
 * it does so last, after the `.o` is fully written, so a half-built object is
 * never visible to {@link loadArtifact}.
 */
export function storeManifest(key: string, manifest: BatchManifest) {
	ensureCacheDir();
	writeFileSync(manifestPath(key), JSON.stringify(manifest));
}

/**
 * Delete every cached entry whose key was not touched this run. Keeps the cache
 * footprint bounded to the current fingerprint instead of accumulating an `.o`
 * set per historical compiler/header revision.
 */
export function pruneUnused(usedKeys: Set<string>) {
	if (!existsSync(cacheDir())) {
		return;
	}

	for (const name of readdirSync(cacheDir())) {
		const key = name.replace(/\.(o|json)$/, "");
		if (!usedKeys.has(key)) {
			rmSync(path.join(cacheDir(), name), { force: true });
		}
	}
}
