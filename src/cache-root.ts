import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MALIGATOR_CACHE_LAYOUT = "v1";

/** Cache configuration that no Maligator command can recover from on its own. */
export class MaligatorCacheRootError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", {
			value: "MaligatorCacheRootError",
			configurable: true,
		});
	}
}

function contains(parent: string, child: string): boolean {
	if (parent === child) return true;
	const relative = path.relative(parent, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function nearestExistingAncestor(target: string): { path: string; directory: boolean } {
	let current = target;
	for (;;) {
		try {
			return { path: current, directory: statSync(current).isDirectory() };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM") {
				throw new MaligatorCacheRootError(
					`cannot inspect the Maligator cache path '${current}' (${code}). This is an environment or sandbox failure: grant write capability for that path or point MALIGATOR_CACHE_DIR at a writable directory, then rerun the exact command.`,
				);
			}
			// ENOTDIR means a path component is a file, which the ancestor walk reports.
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = path.dirname(current);
			if (parent === current) return { path: current, directory: true };
			current = parent;
		}
	}
}

/**
 * A configured cache path that is a file must fail loudly: an unreadable root
 * otherwise looks exactly like a missing directory, so every cache family reads
 * as absent and the command reports a healthy empty cache.
 */
export function assertUsableMaligatorCacheRoot(
	target: string,
	environment: NodeJS.ProcessEnv = process.env,
): void {
	const resolved = path.resolve(target);
	const existing = nearestExistingAncestor(resolved);
	if (existing.directory) return;
	const configured =
		environment.MALIGATOR_CACHE_DIR === undefined
			? undefined
			: path.resolve(environment.MALIGATOR_CACHE_DIR);
	throw new MaligatorCacheRootError(
		[
			`invalid Maligator cache root: '${existing.path}' is a file, not a directory${
				existing.path === resolved
					? ""
					: `, so Maligator cannot create its cache directory '${resolved}' underneath it`
			}.`,
			...(configured === undefined || !contains(configured, resolved)
				? []
				: [`MALIGATOR_CACHE_DIR is set to '${configured}'.`]),
			"Remove or move that file, or point MALIGATOR_CACHE_DIR at a writable directory.",
		].join("\n"),
	);
}

export function maligatorCacheBaseDirectory(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (environment.MALIGATOR_CACHE_DIR !== undefined) {
		return path.resolve(environment.MALIGATOR_CACHE_DIR);
	}
	if (platform === "win32") {
		return path.resolve(
			environment.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
			"Maligator",
			"Cache",
		);
	}
	if (platform === "darwin") {
		return path.resolve(os.homedir(), "Library", "Caches", "maligator");
	}
	return path.resolve(
		environment.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
		"maligator",
	);
}

/** Shared, version-independent root for all rebuildable Maligator artifacts. */
export function maligatorCacheDirectory(
	override?: string,
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (override !== undefined) return path.resolve(override);
	return path.join(
		maligatorCacheBaseDirectory(environment, platform),
		MALIGATOR_CACHE_LAYOUT,
	);
}

/** Checkout-local scratch and user-visible build materialization. */
export function maligatorBuildDirectory(projectRoot = process.cwd()): string {
	return path.resolve(projectRoot, ".cache", "mal-build");
}

export function npmCacheDirectory(environment: NodeJS.ProcessEnv = process.env): string {
	if (environment.npm_config_cache !== undefined) {
		return path.resolve(environment.npm_config_cache);
	}
	if (process.platform === "win32") {
		return path.join(
			environment.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
			"npm-cache",
		);
	}
	return path.join(os.homedir(), ".npm");
}

export function cargoCacheDirectory(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	return path.resolve(environment.CARGO_HOME ?? path.join(os.homedir(), ".cargo"));
}
