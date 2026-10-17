import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import * as path from "node:path";
import { maligatorCacheDirectory } from "../src/cache-root.ts";

/**
 * A directory of symlinks to the given tools, named by the links themselves. The native
 * build environment fingerprint includes PATH, CC and CXX, so a per-run directory would
 * give every native build that runs with it fresh cache keys.
 */
export function isolatedToolsDirectory(links: ReadonlyArray<[string, string]>): string {
	const directory = path.join(
		maligatorCacheDirectory(),
		"work",
		"isolated-tools",
		createHash("sha256").update(JSON.stringify(links)).digest("hex").slice(0, 16),
	);
	if (existsSync(directory)) return directory;
	const staging = `${directory}.${String(process.pid)}`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	for (const [name, source] of links) symlinkSync(source, path.join(staging, name));
	try {
		renameSync(staging, directory);
	} catch (error) {
		// A concurrent check published the same links first.
		rmSync(staging, { recursive: true, force: true });
		if (!existsSync(directory)) throw error;
	}
	return directory;
}
