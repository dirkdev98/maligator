import { hash } from "node:crypto";
import * as path from "node:path";
import { artifactProducer } from "./artifact-store.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { hashDirectoryTreesCached } from "./file-tree.ts";

let implementationDigest: string | undefined;

/**
 * Path-independent digest of the compiler implementation. Package version and
 * declarations are deliberately absent: neither changes emitted artifacts.
 */
export function compilerImplementationDigest(): string {
	if (implementationDigest !== undefined) return implementationDigest;
	const sourceRoot = path.resolve(import.meta.dirname);
	const checkoutKey = hash("sha256", sourceRoot, "hex").slice(0, 20);
	implementationDigest = hashDirectoryTreesCached(
		{
			root: sourceRoot,
			directories: [sourceRoot],
			include: (entry) =>
				(entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) &&
				!entry.name.endsWith(".d.ts") &&
				entry.name !== "version.ts",
		},
		path.join(
			maligatorCacheDirectory(),
			"source-digests",
			`compiler-${checkoutKey}.json`,
		),
		"compiler-implementation-v1",
	).digest;
	return implementationDigest;
}

export function compilerProducerIdentity(stage: string, protocol: number): string {
	return artifactProducer(stage, protocol, compilerImplementationDigest());
}

/** Configuration facts consumed before native emission. */
export function compilerConfigurationIdentity(config: ResolvedBuildConfig): unknown {
	return {
		modules: config.modules,
		engine: {
			primordials: config.engine.primordials,
			eval: config.engine.eval,
			realms: config.engine.realms,
			regexp: config.engine.regexp,
			temporal: config.engine.temporal,
			intl: config.engine.intl.enabled,
		},
		surface: config.surface,
	};
}
