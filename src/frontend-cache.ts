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

export const FRONTEND_CACHE_DIRECTORY = ".cache/mal-cache/frontend";

export interface FrontendDependencyIdentity {
	path: string;
	size: number;
	mtimeMs: number;
	digest: string;
}

export function frontendDigest(contents: string | Uint8Array): string {
	return hash("sha256", contents, "hex");
}

export function frontendWirePath(digest: string, root = FRONTEND_CACHE_DIRECTORY): string {
	return path.resolve(root, "artifacts", `${digest}.malw`);
}

/**
 * Shared coherent filesystem view for builds, tests, and a future watcher.
 * Invalidating one stable file identity makes every frontend consumer observe
 * the same revision while preserving cached digests for unchanged dependencies.
 */
export class FrontendCompilationSession {
	readonly #snapshots = new Map<string, FrontendDependencyIdentity>();

	invalidate(file?: string): void {
		if (file === undefined) {
			this.#snapshots.clear();
		} else {
			this.#snapshots.delete(path.resolve(file));
		}
	}

	snapshot(file: string, knownSource?: string): FrontendDependencyIdentity {
		const resolved = path.resolve(file);
		const cached = this.#snapshots.get(resolved);
		if (cached !== undefined) return cached;
		const stats = statSync(resolved);
		if (!stats.isFile()) throw new Error(`frontend dependency is not a file: ${resolved}`);
		const identity = {
			path: resolved,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			digest:
				knownSource === undefined
					? frontendDigest(new Uint8Array(readFileSync(resolved)))
					: frontendDigest(knownSource),
		};
		this.#snapshots.set(resolved, identity);
		return identity;
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

/** Publish a VM image into the frontend-wide content-addressed artifact store. */
export function cacheFrontendWire(
	wire: Uint8Array,
	root = FRONTEND_CACHE_DIRECTORY,
): string {
	const digest = frontendDigest(wire);
	const file = frontendWirePath(digest, root);
	if (validArtifact(file, digest)) return file;

	const directory = path.dirname(file);
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	const temporaryPath = path.join(temporaryDirectory, path.basename(file));
	try {
		writeFileSync(temporaryPath, wire);
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
