import { hash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { platformLinkArgs } from "./build-flags.ts";
import type { NativeFeatureSpec } from "./build-flags.ts";
import { touchCacheEntry } from "./cache-management.ts";
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
	return hash("sha256", JSON.stringify({ schema: 6, ...inputs }), "hex").slice(0, 24);
}

export interface RustArtifacts {
	cacheKey: string;
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
	const cargoArguments = ["build", "--release", "--no-default-features"];
	if (context.toolchain.cross === true) {
		cargoArguments.push("--target", context.toolchain.rustTarget);
	}
	if (cargoFeatures.length > 0) {
		cargoArguments.push("--features", cargoFeatures.join(","));
	}
	const nativeToolEnvironment = cargoNativeToolEnvironment(context);
	const cacheKey = rustArtifactKey({
		cargoArguments,
		environmentFingerprint: context.environmentFingerprint,
		nativeToolEnvironment: Object.entries(nativeToolEnvironment).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		),
		sourceDigest: cachedRustSourceDigest(rustDirectory, context.cacheDirectory),
		toolchainFingerprint: context.toolchain.fingerprint,
		rustTarget: context.toolchain.rustTarget,
	});
	const targetDirectory = path.join(context.cacheDirectory, "rust", cacheKey, "target");
	const library = path.join(
		targetDirectory,
		...(context.toolchain.cross === true ? [context.toolchain.rustTarget] : []),
		"release",
		"libmal_rust.a",
	);
	return {
		cacheKey,
		targetDirectory,
		library,
		linkArgs: [
			library,
			...(context.features.webPlatformEnabled
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

const RUST_MANIFEST = "artifact.json";

function validRustCache(artifacts: RustArtifacts): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(
				path.join(path.dirname(artifacts.targetDirectory), RUST_MANIFEST),
				"utf-8",
			),
		) as { schema?: unknown; cacheKey?: unknown; librarySize?: unknown };
		const stats = statSync(artifacts.library);
		return (
			manifest.schema === 1 &&
			manifest.cacheKey === artifacts.cacheKey &&
			typeof manifest.librarySize === "number" &&
			manifest.librarySize > 0 &&
			stats.isFile() &&
			stats.size === manifest.librarySize
		);
	} catch {
		return false;
	}
}

function publishRustManifest(artifacts: RustArtifacts, librarySize: number): void {
	const keyDirectory = path.dirname(artifacts.targetDirectory);
	mkdirSync(keyDirectory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(keyDirectory, ".manifest-"));
	try {
		const temporaryPath = path.join(temporaryDirectory, RUST_MANIFEST);
		writeFileSync(
			temporaryPath,
			`${JSON.stringify({ schema: 1, cacheKey: artifacts.cacheKey, librarySize })}\n`,
		);
		renameSync(temporaryPath, path.join(keyDirectory, RUST_MANIFEST));
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

/** Build the Rust FFI static library, relying on Cargo's target-directory locking. */
export function ensureRustArtifacts(
	context: NativeBuildContext,
	verbose = false,
): RustArtifacts {
	const startedAt = performance.now();
	const artifacts = resolveRustArtifacts(context);
	if (validRustCache(artifacts)) {
		touchCacheEntry(path.dirname(artifacts.targetDirectory));
		context.onCacheEvent?.({ artifact: "rust", hit: true, path: artifacts.library });
		context.onBuildPhase?.({
			phase: "rust",
			durationMs: performance.now() - startedAt,
			cache: "hit",
			path: artifacts.library,
		});
		return artifacts;
	}
	context.onCacheEvent?.({ artifact: "rust", hit: false, path: artifacts.library });
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
				CARGO_HOME: path.join(context.cacheDirectory, "cargo"),
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
	publishRustManifest(artifacts, librarySize);
	context.onBuildPhase?.({
		phase: "rust",
		durationMs: performance.now() - startedAt,
		cache: "miss",
		path: artifacts.library,
	});
	return artifacts;
}
