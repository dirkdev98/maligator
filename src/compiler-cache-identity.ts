import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { artifactProducer } from "./artifact-store.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { compilerParserIdentity } from "./compiler-parser-identity.ts";
import { hashDirectoryTreesCached } from "./file-tree.ts";
import { relativeImportCone } from "./source-import-cone.ts";

export const COMPILER_PRODUCER_STAGES = [
	"build-frontend",
	"build-fragment",
	"dependency-fragment",
	"development-fragment-units",
	"generated-sources",
	"test-frontend",
	"test-fragment",
	"ffi-header-model",
	"ffi-binding",
] as const;

export type CompilerProducerStage = (typeof COMPILER_PRODUCER_STAGES)[number];

const PRODUCER_ROOTS: Record<CompilerProducerStage, Array<string>> = {
	// Worker URL construction is outside the import source cone.
	"build-frontend": [
		"build-frontend-cache.ts",
		"node-root-compiler-worker.ts",
		"native-root-compiler-worker.ts",
	],
	"build-fragment": ["build-fragment-cache.ts"],
	"dependency-fragment": ["dependency-fragment-cache.ts"],
	"development-fragment-units": ["development-fragments.ts"],
	"generated-sources": [
		"compiler/target/emit-program-image.ts",
		"compiler/target/emit-worker-images.ts",
		"native-source-path.ts",
	],
	"test-frontend": ["testing/cache.ts"],
	"test-fragment": ["testing/test-images.ts"],
	"ffi-header-model": ["ffi/model-cache.ts"],
	"ffi-binding": ["ffi/library.ts"],
};

let installedProducerDigests: Record<CompilerProducerStage, string> | undefined;
const producerImplementationDigests = new Map<CompilerProducerStage, string>();

export function compilerProducerImplementationDigestForRoot(
	stage: CompilerProducerStage,
	sourceRoot: string,
	cacheDirectory: string,
): string {
	const resolvedSourceRoot = path.resolve(sourceRoot);
	const checkoutKey = hash("sha256", resolvedSourceRoot, "hex").slice(0, 20);
	const manifestPath = path.join(
		cacheDirectory,
		"source-digests",
		`compiler-producer-${stage}-${checkoutKey}.json`,
	);
	const entries = relativeImportCone(
		resolvedSourceRoot,
		PRODUCER_ROOTS[stage],
		manifestPath,
	);
	const packageJson = JSON.parse(
		readFileSync(path.join(resolvedSourceRoot, "..", "package.json"), "utf8"),
	) as { dependencies?: Record<string, string> };
	return hash(
		"sha256",
		JSON.stringify({
			schema: 3,
			stage,
			entries,
			dependencies: packageJson.dependencies ?? {},
			// Clang extracts C header models without invoking the JavaScript parser.
			parser:
				stage === "ffi-header-model"
					? undefined
					: compilerParserIdentity(resolvedSourceRoot),
		}),
		"hex",
	);
}

export function compilerProducerDigestsForRoot(
	sourceRoot: string,
	cacheDirectory: string,
): Record<CompilerProducerStage, string> {
	return Object.fromEntries(
		COMPILER_PRODUCER_STAGES.map((stage) => [
			stage,
			compilerProducerImplementationDigestForRoot(stage, sourceRoot, cacheDirectory),
		]),
	) as Record<CompilerProducerStage, string>;
}

export function installCompilerProducerDigests(
	digests: Record<CompilerProducerStage, string>,
): void {
	for (const stage of COMPILER_PRODUCER_STAGES) {
		if (!/^[0-9a-f]{64}$/.test(digests[stage])) {
			throw new Error(`invalid embedded compiler producer digest for ${stage}`);
		}
	}
	installedProducerDigests = digests;
}

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
	const rootSources = [
		"build-config-error.ts",
		"build-config-values.ts",
		"platform/catalog.ts",
		"platform/execution.ts",
		"utils.ts",
	].flatMap((relativePath) => [
		relativePath,
		"\0",
		hash("sha256", readFileSync(path.join(resolvedSourceRoot, relativePath)), "hex"),
		"\0",
	]);
	return hash(
		"sha256",
		[
			"compiler-implementation-v3\0",
			compilerSources.digest,
			"\0",
			...rootSources,
			"meriyah\0",
			JSON.stringify(compilerParserIdentity(resolvedSourceRoot)),
		].join(""),
		"hex",
	);
}

export function compilerProducerIdentity(
	stage: CompilerProducerStage,
	protocol: number,
): string {
	let digest =
		installedProducerDigests?.[stage] ?? producerImplementationDigests.get(stage);
	if (digest === undefined) {
		digest = compilerProducerImplementationDigestForRoot(
			stage,
			import.meta.dirname,
			maligatorCacheDirectory(),
		);
		producerImplementationDigests.set(stage, digest);
	}
	return artifactProducer(stage, protocol, digest);
}

/** Configuration facts consumed before native emission. */
export function compilerConfigurationIdentity(config: ResolvedBuildConfig): unknown {
	return {
		moduleResolution: {
			aliases: config.modules.aliases,
			conditions: config.modules.conditions,
		},
		world: {
			primordialPolicy: config.engine.primordials,
			dynamicCompilation: config.engine.eval,
			realms: config.engine.realms,
			ecmaFeatures: {
				regexp: config.engine.regexp,
				temporal: config.engine.temporal,
				intl: config.engine.intl.enabled,
				// Selected services decide which Intl components an image retains.
				intlServices: config.engine.intl.enabled ? config.engine.intl.features : [],
			},
		},
		ffiModules: config.ffiModules,
	};
}
