import { hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const CACHE_DIR = ".cache/mal-cache/compiler-wire";
const LEGACY_WIRE = "runtime/src/compiler.malw";

export interface CompilerBakeOptions {
	/** Fresh serialized compiler bytes supplied by any host. */
	bytes?: Uint8Array;
	/** Node-hosted in-process compiler callback, called only when the wire is stale. */
	bake?: () => Uint8Array;
	/** Exact prebuilt wire for a self-hosted eval-enabled build. */
	prebuiltPath?: string;
}

function isCompilerSource(name: string): boolean {
	return [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].some((suffix) =>
		name.endsWith(suffix),
	);
}

function compilerSourceHash(): string {
	const parts: Array<string> = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (isCompilerSource(entry.name)) {
				parts.push(full, "\0", hash("sha256", readFileSync(full, "utf-8"), "hex"), "\0");
			}
		}
	};
	walk("src");
	return hash("sha256", parts.join(""), "hex");
}

function cachedWire(key: string): string {
	return path.resolve(CACHE_DIR, key, "compiler.malw");
}

function writeCachedWire(key: string, bytes: Uint8Array): string {
	const wirePath = cachedWire(key);
	mkdirSync(path.dirname(wirePath), { recursive: true });
	writeFileSync(wirePath, bytes);
	return wirePath;
}

/**
 * Ensure the eval compiler wire is current without launching another language
 * host. Self-hosted callers pass bytes; Node callers pass an in-process bake.
 */
export function ensureCompilerWire(options: CompilerBakeOptions = {}): string {
	if (options.prebuiltPath !== undefined) {
		const bytes = readFileSync(path.resolve(options.prebuiltPath));
		return writeCachedWire(hash("sha256", bytes, "hex"), bytes);
	}
	if (options.bytes !== undefined) {
		return writeCachedWire(hash("sha256", options.bytes, "hex"), options.bytes);
	}
	const sourceHash = compilerSourceHash();
	const wirePath = cachedWire(sourceHash);
	if (existsSync(wirePath)) return wirePath;
	if (process.env.MAL_BAKE === "skip" && existsSync(LEGACY_WIRE)) {
		return writeCachedWire(sourceHash, readFileSync(LEGACY_WIRE));
	}
	if (options.bake === undefined) {
		throw new Error(
			"eval-enabled build needs compiler wire bytes, a prebuilt wire path, or an in-process bake callback",
		);
	}
	return writeCachedWire(sourceHash, options.bake());
}
