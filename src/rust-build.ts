import { hash } from "node:crypto";
import { statSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
	artifactActionKey,
	artifactOutput,
	artifactProducer,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "./artifact-store.ts";
import { platformLinkArgs } from "./build-flags.ts";
import type { NativeFeatureSpec } from "./build-flags.ts";
import { cargoCacheDirectory } from "./cache-root.ts";
import {
	hashDirectoryTrees,
	hashDirectoryTreesCached,
	legacyLocaleNameComparator,
} from "./file-tree.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { runNativeCommand } from "./native-command.ts";
import { formatToolCommand, toolArguments } from "./toolchain.ts";

export { resolvePathExecutable } from "./toolchain.ts";

function rustSourceHashOptions(rustRoot: string) {
	return {
		root: rustRoot,
		directories: [rustRoot],
		include: (entry: { name: string }) => /\.(?:rs|toml|lock)$/.test(entry.name),
		compareNames: legacyLocaleNameComparator,
		descend: (entry: { dirent: { name: string }; relativeSegments: Array<string> }) =>
			entry.relativeSegments.length !== 1 ||
			(entry.dirent.name !== ".cache" && entry.dirent.name !== "target"),
	};
}

/** Digest every Rust source and Cargo input under a runtime's rust directory. */
export function rustSourceDigest(rustDirectory: string): string {
	const rustRoot = path.resolve(rustDirectory);
	return hashDirectoryTrees(rustSourceHashOptions(rustRoot));
}

function cachedRustSourceDigest(rustDirectory: string, cacheDirectory: string): string {
	const rustRoot = path.resolve(rustDirectory);
	const rootKey = hash("sha256", rustRoot, "hex").slice(0, 16);
	return hashDirectoryTreesCached(
		rustSourceHashOptions(rustRoot),
		path.join(cacheDirectory, "source-digests", `rust-${rootKey}.json`),
		"rust-source-v1",
	).digest;
}

export interface RustArtifactKeyInputs {
	cargoArguments: Array<string>;
	environmentFingerprint: string;
	nativeToolEnvironment: Array<[string, string]>;
	sourceDigest: string;
	toolchainFingerprint: string;
	rustTarget: string;
}

export function rustArtifactKey(inputs: RustArtifactKeyInputs): string {
	return artifactActionKey(RUST_PRODUCER, inputs);
}

const RUST_PRODUCER = artifactProducer("rust-library", 1, "cargo-build");
const RUST_TARGET_PRODUCER = artifactProducer("rust-target", 1, "cargo-build");

export interface RustArtifacts {
	cacheKey: string;
	targetKey: string;
	targetDirectory: string;
	library: string;
	linkArgs: Array<string>;
	cargoArguments: Array<string>;
	cargoFeatures: Array<string>;
	nativeToolEnvironment: Readonly<Record<string, string>>;
	features: Readonly<NativeFeatureSpec>;
}

function cargoNativeToolEnvironment(context: NativeBuildContext): Record<string, string> {
	const environment: Record<string, string> = {
		CC: formatToolCommand(context.toolchain.tools.cc),
		AR: formatToolCommand(context.toolchain.tools.ar),
	};
	if (context.toolchain.tools.cxx !== undefined) {
		environment.CXX = formatToolCommand(context.toolchain.tools.cxx);
	}
	if (context.toolchain.cross === true) {
		// cc-rs recognizes Zig as a compiler wrapper only when told its basename.
		// Its Rust-triple defaults would otherwise append a second,
		// Zig-incompatible `--target`; the tool command already carries the
		// canonical Zig target. Zig C and C++ also enable undefined-behavior checks
		// for some optimized constructs by default, so turn them off for ordinary
		// production dependencies rather than leaving unresolved UBSan calls.
		environment.CC_KNOWN_WRAPPER_CUSTOM = path.basename(context.toolchain.tools.cc.path);
		environment.CRATE_CC_NO_DEFAULTS = "1";
		environment.CFLAGS = [context.environment.CFLAGS, "-fno-sanitize=undefined"]
			.filter((value) => value !== undefined && value !== "")
			.join(" ");
		environment.CXXFLAGS = [context.environment.CXXFLAGS, "-fno-sanitize=undefined"]
			.filter((value) => value !== undefined && value !== "")
			.join(" ");
	}
	return environment;
}

/** Resolve exact Cargo arguments and content-addressed paths from one native context. */
export function resolveRustArtifacts(context: NativeBuildContext): RustArtifacts {
	const rustDirectory = path.join(context.runtimeDirectory, "rust");
	const cargoFeatures = [...context.features.cargoFeatures];
	const cargoBaseArguments = ["build", "--release", "--no-default-features"];
	if (context.toolchain.cross === true) {
		cargoBaseArguments.push("--target", context.toolchain.rustTarget);
	}
	const cargoArguments = [...cargoBaseArguments];
	if (cargoFeatures.length > 0) {
		cargoArguments.push("--features", cargoFeatures.join(","));
	}
	const nativeToolEnvironment = cargoNativeToolEnvironment(context);
	const nativeToolEntries = Object.entries(nativeToolEnvironment).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	const sourceDigest = cachedRustSourceDigest(rustDirectory, context.cacheDirectory);
	const cacheKey = rustArtifactKey({
		cargoArguments,
		environmentFingerprint: context.environmentFingerprint,
		nativeToolEnvironment: nativeToolEntries,
		sourceDigest,
		toolchainFingerprint: context.toolchain.fingerprint,
		rustTarget: context.toolchain.rustTarget,
	});
	const targetKey = artifactActionKey(RUST_TARGET_PRODUCER, {
		cargoArguments: cargoBaseArguments,
		environmentFingerprint: context.environmentFingerprint,
		nativeToolEnvironment: nativeToolEntries,
		sourceDigest,
		toolchainFingerprint: context.toolchain.fingerprint,
		rustTarget: context.toolchain.rustTarget,
	});
	const targetDirectory = path.join(
		context.cacheDirectory,
		"work",
		"rust",
		targetKey,
		"target",
	);
	const library = path.join(
		targetDirectory,
		...(context.toolchain.cross === true ? [context.toolchain.rustTarget] : []),
		"release",
		"libmal_rust.a",
	);
	return {
		cacheKey,
		targetKey,
		targetDirectory,
		library,
		linkArgs: [
			library,
			...(context.features.cargoFeatures.includes("url")
				? context.toolchain.probes.cxxLinkArgs
				: []),
			...platformLinkArgs(
				context.toolchain.platform ?? process.platform,
				context.toolchain.cross === true,
			),
		],
		cargoArguments,
		cargoFeatures,
		nativeToolEnvironment,
		features: context.features,
	};
}

function cachedRustArtifacts(artifacts: RustArtifacts, library: string): RustArtifacts {
	return {
		...artifacts,
		library,
		linkArgs: [library, ...artifacts.linkArgs.slice(1)],
	};
}

/** Build the Rust FFI static library with reusable, serialized Cargo work products. */
export function ensureRustArtifacts(
	context: NativeBuildContext,
	verbose = false,
): RustArtifacts {
	const startedAt = performance.now();
	const artifacts = resolveRustArtifacts(context);
	const cached = readArtifactAction(
		context.cacheDirectory,
		"rust-library",
		RUST_PRODUCER,
		artifacts.cacheKey,
	);
	if (cached !== undefined) {
		const library = artifactOutput(cached, "libmal_rust.a").path;
		context.onCacheEvent?.({ artifact: "rust", hit: true, path: library });
		context.onBuildPhase?.({
			phase: "rust",
			durationMs: performance.now() - startedAt,
			cache: "hit",
			path: library,
		});
		return cachedRustArtifacts(artifacts, library);
	}
	context.onCacheEvent?.({ artifact: "rust", hit: false, path: artifacts.library });
	const published = withArtifactActionLock(
		context.cacheDirectory,
		"rust-library",
		RUST_PRODUCER,
		artifacts.cacheKey,
		() => {
			const raced = readArtifactAction(
				context.cacheDirectory,
				"rust-library",
				RUST_PRODUCER,
				artifacts.cacheKey,
			);
			if (raced !== undefined) return raced;
			return withArtifactActionLock(
				context.cacheDirectory,
				"rust-target",
				RUST_TARGET_PRODUCER,
				artifacts.targetKey,
				() => {
					const currentPath = context.environment.PATH ?? "";
					const cargoPath = context.toolchain.tools.cargo.path;
					const toolchainBin = path.dirname(cargoPath);
					runNativeCommand(
						context,
						cargoPath,
						toolArguments(context.toolchain.tools.cargo, artifacts.cargoArguments),
						{
							cwd: path.join(context.runtimeDirectory, "rust"),
							env: {
								...context.environment,
								...artifacts.nativeToolEnvironment,
								PATH: `${toolchainBin}${path.delimiter}${currentPath}`,
								CARGO_HOME: cargoCacheDirectory(context.environment),
								CARGO_TARGET_DIR: artifacts.targetDirectory,
								RUSTC: context.toolchain.tools.rustc.path,
							},
							verbose,
						},
					);
					let librarySize = 0;
					try {
						const stats = statSync(artifacts.library);
						if (stats.isFile()) librarySize = stats.size;
					} catch {
						// Report the common failure below.
					}
					if (librarySize === 0) {
						throw new Error(`cargo completed without producing ${artifacts.library}`);
					}
					return publishArtifactAction(
						context.cacheDirectory,
						"rust-library",
						RUST_PRODUCER,
						artifacts.cacheKey,
						[{ name: "libmal_rust.a", file: artifacts.library }],
					);
				},
			);
		},
	);
	const library = artifactOutput(published, "libmal_rust.a").path;
	context.onBuildPhase?.({
		phase: "rust",
		durationMs: performance.now() - startedAt,
		cache: "miss",
		path: library,
	});
	return cachedRustArtifacts(artifacts, library);
}
