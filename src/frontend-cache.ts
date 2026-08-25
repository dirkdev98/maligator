import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { ModuleParseCache } from "./compiler/frontend/module-graph.ts";

export const FRONTEND_CACHE_DIRECTORY = path.join(maligatorCacheDirectory(), "frontend");

export interface FrontendDependencyIdentity {
	path: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	dev: number;
	digest: string;
}

export interface FrontendArtifactIdentity {
	digest: string;
	path: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	dev: number;
}

interface FileDigestManifest {
	schema: 1;
	projectRoot: string;
	files: Record<string, FrontendDependencyIdentity>;
}

function validDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function readDigestManifest(
	file: string,
	projectRoot: string,
): FileDigestManifest | undefined {
	try {
		const manifest = JSON.parse(readFileSync(file, "utf-8")) as FileDigestManifest;
		if (
			manifest.schema !== 1 ||
			manifest.projectRoot !== projectRoot ||
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

function sameFileIdentity(
	left: FrontendDependencyIdentity,
	right: Omit<FrontendDependencyIdentity, "path" | "digest">,
): boolean {
	return (
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.ino === right.ino &&
		left.dev === right.dev &&
		validDigest(left.digest)
	);
}

export function frontendDigest(contents: string | Uint8Array): string {
	return hash("sha256", contents, "hex");
}

export function frontendWirePath(
	digest: string,
	root = FRONTEND_CACHE_DIRECTORY,
): string {
	return path.resolve(root, "artifacts", `${digest}.malw`);
}

/** Compiler-owned ProgramImage artifact; never pass this path to a runtime loader. */
export function frontendCompilerArtifactPath(
	digest: string,
	root = FRONTEND_CACHE_DIRECTORY,
): string {
	return path.resolve(root, "compiler-artifacts", `${digest}.malc`);
}

function artifactIdentityAt(
	digest: string,
	file: string,
): FrontendArtifactIdentity | undefined {
	try {
		const stats = statSync(file);
		if (!stats.isFile()) return undefined;
		return {
			digest,
			path: file,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ctimeMs: stats.ctimeMs,
			ino: stats.ino,
			dev: stats.dev,
		};
	} catch {
		return undefined;
	}
}

export function frontendArtifactIdentity(
	digest: string,
	root = FRONTEND_CACHE_DIRECTORY,
): FrontendArtifactIdentity | undefined {
	return artifactIdentityAt(digest, frontendWirePath(digest, root));
}

export function frontendCompilerArtifactIdentity(
	digest: string,
	root = FRONTEND_CACHE_DIRECTORY,
): FrontendArtifactIdentity | undefined {
	return artifactIdentityAt(digest, frontendCompilerArtifactPath(digest, root));
}

function artifactUnchanged(
	artifact: FrontendArtifactIdentity,
	current: FrontendArtifactIdentity | undefined,
): boolean {
	return (
		/^[0-9a-f]{64}$/.test(artifact.digest) &&
		current !== undefined &&
		current.path === artifact.path &&
		current.size === artifact.size &&
		current.mtimeMs === artifact.mtimeMs &&
		current.ctimeMs === artifact.ctimeMs &&
		current.ino === artifact.ino &&
		current.dev === artifact.dev
	);
}

export function frontendArtifactUnchanged(
	artifact: FrontendArtifactIdentity,
	root = FRONTEND_CACHE_DIRECTORY,
): boolean {
	return artifactUnchanged(artifact, frontendArtifactIdentity(artifact.digest, root));
}

export function frontendCompilerArtifactUnchanged(
	artifact: FrontendArtifactIdentity,
	root = FRONTEND_CACHE_DIRECTORY,
): boolean {
	return artifactUnchanged(
		artifact,
		frontendCompilerArtifactIdentity(artifact.digest, root),
	);
}

/**
 * Shared coherent filesystem view for builds, tests, and a future watcher.
 * Invalidating one stable file identity makes every frontend consumer observe
 * the same revision while preserving cached digests for unchanged dependencies.
 */
export class FrontendCompilationSession {
	readonly #snapshots = new Map<string, FrontendDependencyIdentity>();
	readonly moduleParses = new ModuleParseCache();
	#digestManifestPath: string | undefined;
	#digestManifest: FileDigestManifest | undefined;
	#digestManifestDirty = false;
	#invalidated = new Set<string>();
	#invalidateAll = false;
	#digestHits = 0;
	#digestMisses = 0;

	/** Attach this session to the shared project cache before reading dependencies. */
	useCacheDirectory(cacheDirectory?: string): void {
		const root = maligatorCacheDirectory(cacheDirectory);
		const projectRoot = path.resolve(process.cwd());
		const file = path.join(
			root,
			"file-digests",
			`${frontendDigest(projectRoot).slice(0, 24)}.json`,
		);
		if (this.#digestManifestPath === file) return;
		if (this.#digestManifestPath !== undefined) {
			throw new Error("a frontend compilation session cannot change cache directories");
		}
		this.#digestManifestPath = file;
		this.#digestManifest = readDigestManifest(file, projectRoot) ?? {
			schema: 1,
			projectRoot,
			files: {},
		};
	}

	invalidate(file?: string): void {
		if (file === undefined) {
			this.#snapshots.clear();
			this.moduleParses.invalidate();
			this.#invalidateAll = true;
			this.#invalidated.clear();
		} else {
			const resolved = path.resolve(file);
			this.#snapshots.delete(resolved);
			this.moduleParses.invalidate(resolved);
			this.#invalidated.add(resolved);
		}
	}

	snapshot(file: string, knownSource?: string): FrontendDependencyIdentity {
		const resolved = path.resolve(file);
		const cached = this.#snapshots.get(resolved);
		if (cached !== undefined) return cached;
		const stats = statSync(resolved);
		if (!stats.isFile())
			throw new Error(`frontend dependency is not a file: ${resolved}`);
		const statIdentity = {
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ctimeMs: stats.ctimeMs,
			ino: stats.ino,
			dev: stats.dev,
		};
		const persistent = this.#digestManifest?.files[resolved];
		const mayReuse =
			knownSource === undefined &&
			!this.#invalidateAll &&
			!this.#invalidated.has(resolved) &&
			persistent !== undefined &&
			sameFileIdentity(persistent, statIdentity);
		const identity: FrontendDependencyIdentity = {
			path: resolved,
			...statIdentity,
			digest:
				knownSource !== undefined
					? frontendDigest(knownSource)
					: mayReuse
						? persistent.digest
						: frontendDigest(new Uint8Array(readFileSync(resolved))),
		};
		if (knownSource === undefined) {
			if (mayReuse) this.#digestHits++;
			else this.#digestMisses++;
		}
		this.#snapshots.set(resolved, identity);
		this.#invalidated.delete(resolved);
		if (this.#digestManifest !== undefined) {
			const previous = this.#digestManifest.files[resolved];
			if (
				previous === undefined ||
				previous.digest !== identity.digest ||
				!sameFileIdentity(previous, identity)
			) {
				this.#digestManifest.files[resolved] = identity;
				this.#digestManifestDirty = true;
			}
		}
		return identity;
	}

	/** Atomically publish file digests learned during this compilation. */
	flush(): void {
		this.#invalidateAll = false;
		if (
			!this.#digestManifestDirty ||
			this.#digestManifestPath === undefined ||
			this.#digestManifest === undefined
		) {
			return;
		}
		const current = readDigestManifest(
			this.#digestManifestPath,
			this.#digestManifest.projectRoot,
		);
		const manifest: FileDigestManifest = {
			...this.#digestManifest,
			files: { ...current?.files, ...this.#digestManifest.files },
		};
		const directory = path.dirname(this.#digestManifestPath);
		mkdirSync(directory, { recursive: true });
		const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
		try {
			const temporaryPath = path.join(temporaryDirectory, "manifest.json");
			writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`);
			renameSync(temporaryPath, this.#digestManifestPath);
		} finally {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
		this.#digestManifest = manifest;
		this.#digestManifestDirty = false;
	}

	/** Persistent digest-index activity since this session was created. */
	digestStatistics(): { hits: number; misses: number } {
		return { hits: this.#digestHits, misses: this.#digestMisses };
	}
}

/** Keep explicit cache overrides isolated while sharing the default process cache. */
export function frontendArtifactCacheRoot(override?: string): string {
	return override === undefined
		? path.resolve(FRONTEND_CACHE_DIRECTORY)
		: path.resolve(override, "frontend");
}

function validArtifact(file: string, expectedDigest: string): boolean {
	try {
		return frontendDigest(new Uint8Array(readFileSync(file))) === expectedDigest;
	} catch {
		return false;
	}
}

function cacheFrontendArtifact(
	contents: Uint8Array,
	file: string,
	digest: string,
): string {
	if (validArtifact(file, digest)) return file;

	const directory = path.dirname(file);
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	const temporaryPath = path.join(temporaryDirectory, path.basename(file));
	try {
		writeFileSync(temporaryPath, contents);
		try {
			renameSync(temporaryPath, file);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" || !validArtifact(file, digest)) throw error;
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	if (!existsSync(file) || !validArtifact(file, digest)) {
		throw new Error(`frontend artifact publication failed: ${file}`);
	}
	return file;
}

/** Publish a runtime-only MALW image into the frontend artifact store. */
export function cacheFrontendWire(
	wire: Uint8Array,
	root = FRONTEND_CACHE_DIRECTORY,
): string {
	const digest = frontendDigest(wire);
	return cacheFrontendArtifact(wire, frontendWirePath(digest, root), digest);
}

/** Publish a compiler-only MALC ProgramImage artifact into its separate store. */
export function cacheFrontendCompilerArtifact(
	artifact: Uint8Array,
	root = FRONTEND_CACHE_DIRECTORY,
): string {
	const digest = frontendDigest(artifact);
	return cacheFrontendArtifact(
		artifact,
		frontendCompilerArtifactPath(digest, root),
		digest,
	);
}
