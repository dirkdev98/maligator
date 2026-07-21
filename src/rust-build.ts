import { execFileSync } from "node:child_process";
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
import type { NativeFeatureSpec } from "./build-flags.ts";
import { hashDirectoryTrees, legacyLocaleNameComparator } from "./file-tree.ts";
import type { NativeBuildContext } from "./native-build-context.ts";

export { resolvePathExecutable } from "./toolchain.ts";

/** Digest every Rust source and Cargo input under a runtime's rust directory. */
export function rustSourceDigest(rustDirectory: string): string {
	const rustRoot = path.resolve(rustDirectory);
	return hashDirectoryTrees({
		root: rustRoot,
		directories: [rustRoot],
		include: (entry) => /\.(?:rs|toml|lock)$/.test(entry.name),
		compareNames: legacyLocaleNameComparator,
	});
}

export interface RustArtifactKeyInputs {
	cargoArguments: Array<string>;
	environmentFingerprint: string;
	sourceDigest: string;
	toolchainFingerprint: string;
	rustTarget: string;
}

export function rustArtifactKey(inputs: RustArtifactKeyInputs): string {
	return hash("sha256", JSON.stringify({ schema: 5, ...inputs }), "hex").slice(0, 24);
}

export interface RustArtifacts {
	cacheKey: string;
	targetDirectory: string;
	library: string;
	linkArgs: Array<string>;
	cargoArguments: Array<string>;
	cargoFeatures: Array<string>;
	features: Readonly<NativeFeatureSpec>;
}

/** Resolve exact Cargo arguments and content-addressed paths from one native context. */
export function resolveRustArtifacts(context: NativeBuildContext): RustArtifacts {
	const rustDirectory = path.join(context.runtimeDirectory, "rust");
	const cargoFeatures = [...context.features.cargoFeatures];
	const cargoArguments = ["build", "--release", "--no-default-features"];
	if (cargoFeatures.length > 0) {
		cargoArguments.push("--features", cargoFeatures.join(","));
	}
	const cacheKey = rustArtifactKey({
		cargoArguments,
		environmentFingerprint: context.environmentFingerprint,
		sourceDigest: rustSourceDigest(rustDirectory),
		toolchainFingerprint: context.toolchain.fingerprint,
		rustTarget: context.toolchain.rustTarget,
	});
	const targetDirectory = path.join(context.cacheDirectory, "rust", cacheKey, "target");
	const library = path.join(targetDirectory, "release", "libmal_rust.a");
	return {
		cacheKey,
		targetDirectory,
		library,
		linkArgs: context.features.webPlatformEnabled
			? [library, ...context.toolchain.probes.cxxLinkArgs]
			: [library],
		cargoArguments,
		cargoFeatures,
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
	const artifacts = resolveRustArtifacts(context);
	if (validRustCache(artifacts)) {
		context.onCacheEvent?.({ artifact: "rust", hit: true, path: artifacts.library });
		return artifacts;
	}
	context.onCacheEvent?.({ artifact: "rust", hit: false, path: artifacts.library });
	const currentPath = context.environment.PATH ?? "";
	const cargoPath = context.toolchain.tools.cargo.path;
	const toolchainBin = path.dirname(cargoPath);

	execFileSync(cargoPath, artifacts.cargoArguments, {
		cwd: path.join(context.runtimeDirectory, "rust"),
		env: {
			...context.environment,
			PATH: `${toolchainBin}${path.delimiter}${currentPath}`,
			CC: context.toolchain.tools.cc.path,
			...(context.toolchain.tools.cxx === undefined
				? {}
				: { CXX: context.toolchain.tools.cxx.path }),
			CARGO_HOME: path.join(context.cacheDirectory, "cargo"),
			CARGO_TARGET_DIR: artifacts.targetDirectory,
			RUSTC: context.toolchain.tools.rustc.path,
		},
		stdio: verbose ? "inherit" : "pipe",
	});
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
	return artifacts;
}
