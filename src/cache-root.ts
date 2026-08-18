import * as os from "node:os";
import * as path from "node:path";

export const MALIGATOR_CACHE_LAYOUT = "v1";

function cacheBaseDirectory(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): string {
	if (environment.MALIGATOR_CACHE_DIR !== undefined) {
		return environment.MALIGATOR_CACHE_DIR;
	}
	if (platform === "win32") {
		return path.join(
			environment.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
			"Maligator",
			"Cache",
		);
	}
	if (platform === "darwin") {
		return path.join(os.homedir(), "Library", "Caches", "maligator");
	}
	return path.join(
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
	return path.resolve(cacheBaseDirectory(environment, platform), MALIGATOR_CACHE_LAYOUT);
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
