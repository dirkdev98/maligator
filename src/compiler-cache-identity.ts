import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { artifactProducer } from "./artifact-store.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { hashDirectoryTreesCached } from "./file-tree.ts";

let implementationDigest: string | undefined;

export function compilerImplementationDigestForRoot(
	sourceRoot: string,
	cacheDirectory: string,
): string {
	const resolvedSourceRoot = path.resolve(sourceRoot);
	const compilerRoot = path.join(resolvedSourceRoot, "compiler");
	const checkoutKey = hash("sha256", sourceRoot, "hex").slice(0, 20);
	const compilerSources = hashDirectoryTreesCached(
		{
			root: resolvedSourceRoot,
			directories: [compilerRoot],
			include: (entry) =>
				(entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) &&
				!entry.name.endsWith(".d.ts"),
		},
		path.join(cacheDirectory, "source-digests", `compiler-cone-${checkoutKey}.json`),
		"compiler-implementation-cone-v2",
	);
	const rootSources = ["build-config-error.ts", "utils.ts"].flatMap((relativePath) => [
		relativePath,
		"\0",
		hash("sha256", readFileSync(path.join(resolvedSourceRoot, relativePath)), "hex"),
		"\0",
	]);
	const packageJson = JSON.parse(
		readFileSync(path.join(resolvedSourceRoot, "..", "package.json"), "utf8"),
	) as { dependencies?: { meriyah?: unknown } };
	const meriyahVersion = packageJson.dependencies?.meriyah;
	if (typeof meriyahVersion !== "string") {
		throw new Error("compiler cache identity requires a pinned Meriyah dependency");
	}
	return hash(
		"sha256",
		[
			"compiler-implementation-v2\0",
			compilerSources.digest,
			"\0",
			...rootSources,
			"meriyah\0",
			meriyahVersion,
		].join(""),
		"hex",
	);
}

/** Path-independent digest of the runtime compiler implementation. */
export function compilerImplementationDigest(): string {
	if (implementationDigest !== undefined) return implementationDigest;
	implementationDigest = compilerImplementationDigestForRoot(
		import.meta.dirname,
		maligatorCacheDirectory(),
	);
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
