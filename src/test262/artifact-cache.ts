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
import { maligatorCacheDirectory } from "../cache-root.ts";
import { compilerImplementationDigest } from "../compiler-cache-identity.ts";

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
 * fingerprint of the compiler implementation, dependency lock, and every runtime
 * header (`runtime/src/**.h`) plus the cc flags, so any change
 * that could alter the emitted `.o` changes the key. Run results are never cached
 * - we always execute the binary - so flakes and behavioural changes still surface.
 */

// Each strictness pass and backend keeps its own cache. Strict and sloppy source
// is byte-identical (strictness flows through the parser), while compiled and
// interpreted objects differ by emit mode. Separate directories also let a full
// interpreted runs prune stale entries without deleting warm compiled
// artifacts, and vice versa. Read lazily because runVariant sets strictness after
// this module is imported.
function cacheDir(): string {
	const variant = process.env.T262_VARIANT ?? "unknown";
	const backend = process.env.MAL_INTERP === "1" ? "interpreted" : "compiled";
	return path.join(
		maligatorCacheDirectory(),
		"test262-artifacts",
		`${variant}-${backend}`,
	);
}

/**
 * Per-batch manifest stored alongside the `.o`. It captures everything the
 * compile phase produced so a cache hit can reconstruct the exact same run
 * verdicts, failure buckets and code-size stats without re-compiling.
 */
export interface BatchManifest {
	schemaVersion: 1;
	hasBinary: boolean;
	/** UTF-8 byte length of the emitted translation unit, or null when no C was emitted. */
	generatedCBytes: number | null;
	/** Tests that produced C, in driver index order. */
	entries: Array<{
		path: string;
		index: number;
		mode: "shared" | "legacy";
		stats: {
			functionCount: number;
			instructionCount: number;
			opcodes: Record<string, number>;
		};
	}>;
	/** Tests resolved during compile (skipped / compile-failed). */
	resolved: Array<{
		path: string;
		result: string;
		failure?: string;
	}>;
	stats: {
		/** Logical totals, attributing each test's helper code to that test. */
		compiledFiles: number;
		functionCount: number;
		instructionCount: number;
		opcodes: Record<string, number>;
	};
	physical: {
		definitionCount: number;
		sharedHelperCount: number;
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

const CACHED_FINGERPRINTS = new Map<string, string>();

/**
 * A stable hash of every input that can change a batch's `.o`: the whole
 * compiler implementation plus dependency lock, every runtime header, and the cc
 * flags. The runtime `.c` files are deliberately excluded - they compile
 * into the library we always re-link, not into the batch object - which is
 * exactly what makes the implementation-edit loop a cache hit.
 */
export function buildFingerprint(
	ccFlags: Array<string>,
	toolchainFingerprint: string,
): string {
	const inputs = JSON.stringify({ ccFlags, toolchainFingerprint });
	const cached = CACHED_FINGERPRINTS.get(inputs);
	if (cached !== undefined) return cached;

	const hash = createHash("sha256");
	hash.update("v1-shared-test262-helpers\n");
	hash.update(compilerImplementationDigest());
	hashDirectory(hash, "runtime/src", [".h"]);
	if (existsSync("package-lock.json")) {
		hash.update("package-lock.json");
		hash.update(readFileSync("package-lock.json"));
	}
	hash.update(JSON.stringify(ccFlags));
	hash.update(toolchainFingerprint);

	const fingerprint = hash.digest("hex");
	CACHED_FINGERPRINTS.set(inputs, fingerprint);
	return fingerprint;
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
	hash.update("batch-schema-v1\n");
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
	if (
		manifest.schemaVersion !== 1 ||
		manifest.physical === undefined ||
		!(typeof manifest.generatedCBytes === "number" || manifest.generatedCBytes === null)
	) {
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
