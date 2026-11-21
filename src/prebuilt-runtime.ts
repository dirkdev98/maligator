import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import * as path from "node:path";
import {
	artifactDigest,
	artifactFileDigest,
	artifactIdentity,
	artifactProducer,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "./artifact-store.ts";
import { ccExtraFlags, runtimeOptimizationFlags } from "./build-flags.ts";
import type { NativeFeatureSpec } from "./build-flags.ts";
import { hashDirectoryTreesCached, lexicalNameComparator } from "./file-tree.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { PINNED_ZIG_VERSION } from "./toolchain-fetch.ts";
import {
	compilerMatchesRustTarget,
	nativeRustTarget,
	resolveZigCrossTarget,
	SUPPORTED_ZIG_CROSS_TARGETS,
} from "./toolchain.ts";

export const PREBUILT_RUNTIME_DIRECTORY = "runtime-libraries";
export const PREBUILT_RUNTIME_MANIFEST = "manifest.json";
export const RELEASE_MACOS_VERSION = "15.0";
export const PREBUILT_RUNTIME_OVERRIDE = "MALIGATOR_PREBUILT_RUNTIME_DIR";
export const PREBUILT_RUNTIME_CC_FLAGS = ["-fPIC", "-fno-sanitize=undefined"];
export const RUNTIME_ARCHIVES = {
	runtime: "libMalRuntime.a",
	host: "libMalHost.a",
	engine: "libLibMaligator.a",
} as const;
const runtimeArchiveNames: ReadonlyArray<string> = Object.values(RUNTIME_ARCHIVES);
export const RUST_LIBRARY_OUTPUT = "libmal_rust.a";
export const NATIVE_OUTPUT_PREFIX = "native.";
export const DEVELOPMENT_RUNNERS = {
	standalone: "maligator-dev",
	testHost: "maligator-test-host",
} as const;
export type DevelopmentRunnerKind = keyof typeof DEVELOPMENT_RUNNERS;
export function prebuiltRuntimeCxxLibraries(target: string) {
	const platform = prebuiltRuntimeTarget(target).platform;
	return [
		{ archive: "libc++.a", license: "libcxx" },
		{ archive: "libc++abi.a", license: "libcxxabi" },
		...(platform === "linux" ? [{ archive: "libunwind.a", license: "libunwind" }] : []),
	];
}

const releaseFlavour = { primordialsLocked: true, realmsEnabled: false };
const releaseProducer = `zig@${PINNED_ZIG_VERSION}`;
const customCodegenVariables = [
	/^(?:AR|C|CPP|CXX)FLAGS(?:_|$)/,
	/^(?:TARGET|HOST)_(?:AR|C|CXX)FLAGS$/,
	/^(?:CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|CRATE_CC_NO_DEFAULTS)$/,
	/^(?:RUSTFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER)$/,
	/^CARGO_(?:BUILD_TARGET$|ENCODED_RUSTFLAGS$|PROFILE_|TARGET_.*_RUSTFLAGS$)/,
];

export function prebuiltRuntimeTarget(triple: string) {
	const target = resolveZigCrossTarget(triple);
	const version = target.platform === "darwin" ? RELEASE_MACOS_VERSION : "2.31";
	const abi = `${target.platform === "darwin" ? "macos" : "glibc"}.${version}`;
	const architecture = target.arch === "arm64" ? "aarch64" : "x86_64";
	return {
		...target,
		abi,
		zigTarget: `${target.zigTarget}.${version}`,
		// Apple Silicon has AES instructions from the first M1. ring's Darwin
		// assembly omits an explicit crypto architecture directive.
		zigCpu:
			target.arch === "arm64"
				? target.platform === "darwin"
					? "-mcpu=apple_m1"
					: "-mcpu=generic"
				: "-march=x86_64",
		clangTarget:
			target.platform === "darwin" ? `${architecture}-apple-macos${version}` : triple,
		clangCpu:
			target.arch === "arm64"
				? target.platform === "darwin"
					? "-mcpu=apple-m1"
					: "-mcpu=generic"
				: "-march=x86-64",
	};
}

interface RuntimeFlavour {
	primordialsLocked: boolean;
	realmsEnabled: boolean;
}

export interface PrebuiltRuntimeIdentity {
	schema: 2;
	target: string;
	abi: string;
	flavour: RuntimeFlavour;
	variant: "development";
	producer: string;
	key: string;
	rustKey: string;
}

/** The machine-code archives can be linked independently of the C runtime. */
export function prebuiltRustKey(
	triple: string,
	sourceDigest: string,
	rustArchiveProducer: string,
): string {
	const { abi, zigTarget, zigCpu } = prebuiltRuntimeTarget(triple);
	return artifactIdentity({
		target: triple,
		abi,
		producer: releaseProducer,
		zigTarget,
		zigCpu,
		zigFlags: PREBUILT_RUNTIME_CC_FLAGS,
		sourceDigest,
		rustArchiveProducer,
	});
}

/** Key the release archive set by its inputs and the pinned producer contract. */
export function prebuiltRuntimeIdentity(inputs: {
	target: string;
	flavour: RuntimeFlavour;
	compileArguments: ReadonlyArray<string>;
	cSourceDigest: string;
	rustSourceDigest: string;
	cArchiveProducer: string;
	rustArchiveProducer: string;
}): PrebuiltRuntimeIdentity {
	const target = prebuiltRuntimeTarget(inputs.target);
	const { primordialsLocked, realmsEnabled } = inputs.flavour;
	const identity = {
		schema: 2,
		target: inputs.target,
		abi: target.abi,
		flavour: { primordialsLocked, realmsEnabled },
		variant: "development",
		producer: releaseProducer,
	} as const;
	return {
		...identity,
		rustKey: prebuiltRustKey(
			inputs.target,
			inputs.rustSourceDigest,
			inputs.rustArchiveProducer,
		),
		key: artifactIdentity({
			...identity,
			zigTarget: target.zigTarget,
			clangTarget: target.clangTarget,
			zigCpu: target.zigCpu,
			clangCpu: target.clangCpu,
			zigFlags: PREBUILT_RUNTIME_CC_FLAGS,
			compileArguments: inputs.compileArguments,
			cSourceDigest: inputs.cSourceDigest,
			rustSourceDigest: inputs.rustSourceDigest,
			cArchiveProducer: inputs.cArchiveProducer,
			rustArchiveProducer: inputs.rustArchiveProducer,
		}),
	};
}

export interface PrebuiltRuntimeFile {
	name: string;
	sha256: string;
	size: number;
}

export interface PrebuiltRuntimeManifest extends PrebuiltRuntimeIdentity {
	files: Array<PrebuiltRuntimeFile>;
	runners: Partial<Record<DevelopmentRunnerKind, PrebuiltDevelopmentRunner>>;
}

export interface PrebuiltDevelopmentRunner extends PrebuiltRuntimeFile {
	key: string;
}

export interface PrebuiltRuntime {
	directory: string;
	manifest: PrebuiltRuntimeManifest;
}

export function prebuiltRuntimeDirectory(
	context: NativeBuildContext,
): string | undefined {
	const { environment, features, plan, toolchain } = context;
	if (
		plan.mode !== "development" ||
		plan.lto ||
		toolchain.cross === true ||
		features.primordialsLocked !== releaseFlavour.primordialsLocked ||
		features.realmsEnabled !== releaseFlavour.realmsEnabled ||
		!canUsePrebuiltRuntime(toolchain.rustTarget, toolchain.target, environment)
	)
		return undefined;
	return packagedRuntimeDirectory(environment);
}

export function prebuiltProductionRustDirectory(
	target: string,
	features: RuntimeFlavour,
	environment: NodeJS.ProcessEnv,
	ccTarget = target,
): string | undefined {
	if (
		features.primordialsLocked !== releaseFlavour.primordialsLocked ||
		features.realmsEnabled !== releaseFlavour.realmsEnabled ||
		!canUsePrebuiltRuntime(target, ccTarget, environment)
	)
		return undefined;
	return packagedRuntimeDirectory(environment);
}

export function packagedRuntimeDirectory(
	environment: NodeJS.ProcessEnv,
): string | undefined {
	const override = environment[PREBUILT_RUNTIME_OVERRIDE];
	if (override !== undefined) return override === "" ? undefined : path.resolve(override);
	try {
		const directory = path.resolve(
			path.dirname(realpathSync(process.execPath)),
			"..",
			PREBUILT_RUNTIME_DIRECTORY,
		);
		return existsSync(path.join(directory, PREBUILT_RUNTIME_MANIFEST))
			? directory
			: undefined;
	} catch {
		return undefined;
	}
}

/** A runner needs the host ABI, with no dependency on the host compiler's target. */
export function prebuiltDevelopmentRunnerTarget(
	environment: NodeJS.ProcessEnv,
): string | undefined {
	const target = nativeRustTarget(process.platform, process.arch);
	return target !== undefined && canUsePrebuiltRuntime(target, target, environment)
		? target
		: undefined;
}

/** The consumer's compilation and link must target the producer's native ABI. */
function canUsePrebuiltRuntime(
	target: string,
	ccTarget: string,
	environment: NodeJS.ProcessEnv,
): boolean {
	if (!SUPPORTED_ZIG_CROSS_TARGETS.includes(target)) return false;
	if (!compilerMatchesRustTarget(ccTarget, target)) return false;
	const { platform } = prebuiltRuntimeTarget(target);
	if (platform === "darwin") {
		const deploymentTarget = environment.MACOSX_DEPLOYMENT_TARGET;
		if (
			deploymentTarget &&
			!(
				Number(deploymentTarget.split(".")[0]) >=
				Number(RELEASE_MACOS_VERSION.split(".")[0])
			)
		)
			return false;
	}

	// These settings change the sources, code generation or ABI of a local library.
	return !Object.entries(environment).some(
		([name, value]) =>
			value && customCodegenVariables.some((variable) => variable.test(name)),
	);
}

/** Portable link identity for an executable that embeds the release runtime. */
export function prebuiltDevelopmentRunnerKey(inputs: {
	target: string;
	runtimeDirectory: string;
	cacheDirectory: string;
	features: Readonly<NativeFeatureSpec>;
	environment: NodeJS.ProcessEnv;
	anchorSource: string;
}): string {
	const target = prebuiltRuntimeTarget(inputs.target);
	const root = inputs.runtimeDirectory;
	const source = hashDirectoryTreesCached(
		{
			root,
			directories: [
				"src",
				"rust",
				"vendor/llhttp/include",
				"vendor/llhttp/src",
				"vendor/sqlite",
			]
				.map((directory) => path.join(root, directory))
				.filter(existsSync),
			include: (entry) => /\.(?:c|h|inc|rs|toml|lock)$/.test(entry.name),
			descend: ({ fullPath }) =>
				fullPath !== path.join(root, "rust", "target") &&
				fullPath !== path.join(root, "rust", ".cache"),
			compareNames: lexicalNameComparator,
		},
		path.join(
			inputs.cacheDirectory,
			"source-digests",
			`development-runner-${artifactDigest(root).slice(0, 16)}.json`,
		),
		"release-development-runner-v1",
	).digest;
	return artifactIdentity({
		schema: 1,
		target,
		producer: releaseProducer,
		zigFlags: PREBUILT_RUNTIME_CC_FLAGS,
		features: inputs.features,
		compileArguments: ccExtraFlags(undefined, inputs.environment, target.platform),
		runtimeOptimization: runtimeOptimizationFlags(inputs.environment),
		runtimeSourceDigest: source,
		mainSourceDigest: artifactFileDigest(path.join(root, "dev_main.c")),
		anchorSource: inputs.anchorSource,
	});
}

function validArchiveNames(
	names: ReadonlyArray<string>,
	target: string,
	includeC: boolean,
): boolean {
	const ringArchive = /^native\.ring\.libring_core_[a-z0-9_]+\.a$/;
	const required = [
		...(includeC ? runtimeArchiveNames : []),
		RUST_LIBRARY_OUTPUT,
		"native.ada-url.libada.a",
		...prebuiltRuntimeCxxLibraries(target).map(
			({ license }) => `native.ada-url.${license}.a`,
		),
	];
	return (
		new Set(names).size === names.length &&
		required.every((name) => names.includes(name)) &&
		names.some((name) => ringArchive.test(name) && !name.endsWith("__test.a")) &&
		names.every((name) => required.includes(name) || ringArchive.test(name))
	);
}

function matchesFile(
	file: string,
	expected: PrebuiltRuntimeFile,
	executable = false,
): boolean {
	const stats = statSync(file);
	return (
		stats.isFile() &&
		(!executable || (stats.mode & 0o111) !== 0) &&
		stats.size === expected.size &&
		artifactFileDigest(file) === expected.sha256
	);
}

function readRuntimeManifest(
	directory: string,
	target: string,
	key?: string,
): PrebuiltRuntimeManifest | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(path.join(directory, PREBUILT_RUNTIME_MANIFEST), "utf8"),
		) as PrebuiltRuntimeManifest;
		if (
			manifest.schema !== 2 ||
			manifest.target !== target ||
			manifest.abi !== prebuiltRuntimeTarget(target).abi ||
			manifest.variant !== "development" ||
			manifest.producer !== releaseProducer ||
			manifest.flavour.primordialsLocked !== releaseFlavour.primordialsLocked ||
			manifest.flavour.realmsEnabled !== releaseFlavour.realmsEnabled ||
			typeof manifest.key !== "string" ||
			!/^[0-9a-f]{64}$/.test(manifest.key) ||
			typeof manifest.rustKey !== "string" ||
			!/^[0-9a-f]{64}$/.test(manifest.rustKey) ||
			(key !== undefined && manifest.key !== key)
		)
			return undefined;
		return manifest;
	} catch {
		return undefined;
	}
}

/** A release archive set is usable only when every listed archive is intact. */
export function readPrebuiltRuntime(
	directory: string,
	target: string,
	key?: string,
): PrebuiltRuntime | undefined {
	return readArchiveSet(directory, target, true, key);
}

/** Production imports machine-code Rust and component archives by their own key. */
export function readPrebuiltRust(
	directory: string,
	target: string,
	key: string,
): PrebuiltRuntime | undefined {
	return readArchiveSet(directory, target, false, key);
}

function readArchiveSet(
	directory: string,
	target: string,
	includeC: boolean,
	key?: string,
): PrebuiltRuntime | undefined {
	const manifest = readRuntimeManifest(directory, target, includeC ? key : undefined);
	if (manifest === undefined) return undefined;
	try {
		if (!Array.isArray(manifest.files) || (!includeC && manifest.rustKey !== key))
			return undefined;
		const files = includeC
			? manifest.files
			: manifest.files.filter(({ name }) => !runtimeArchiveNames.includes(name));
		if (
			!validArchiveNames(
				files.map(({ name }) => name),
				target,
				includeC,
			) ||
			!files.every(
				(file) =>
					Number.isSafeInteger(file.size) &&
					file.size > 0 &&
					matchesFile(path.join(directory, file.name), file),
			)
		)
			return undefined;
		return { directory, manifest: { ...manifest, files } };
	} catch {
		return undefined;
	}
}

/** Check only the executable being selected, so archive damage and runner damage are independent. */
export function readPrebuiltDevelopmentRunner(
	directory: string,
	target: string,
	kind: DevelopmentRunnerKind,
	key?: string,
): string | undefined {
	const runner = readRuntimeManifest(directory, target)?.runners?.[kind];
	const name = DEVELOPMENT_RUNNERS[kind];
	if (
		runner?.name !== name ||
		typeof runner.key !== "string" ||
		!/^[0-9a-f]{64}$/.test(runner.key) ||
		(key !== undefined && runner.key !== key) ||
		!Number.isSafeInteger(runner.size) ||
		runner.size <= 0
	)
		return undefined;
	const file = path.join(directory, name);
	try {
		return matchesFile(file, runner, true) ? file : undefined;
	} catch {
		return undefined;
	}
}

/**
 * An imported action has the consumer's exact key in a separate namespace.
 * Rust and non-LTO C can share their local key with production.
 */
export function importPrebuiltRuntimeAction(
	root: string,
	stage: "runtime-archive" | "rust-library",
	producer: string,
	action: string,
	bundle: PrebuiltRuntime,
): ReturnType<typeof readArtifactAction> {
	const importProducer = artifactProducer(stage, 1, `release-archives:${producer}`);
	const files = bundle.manifest.files.filter(
		({ name }) => runtimeArchiveNames.includes(name) === (stage === "runtime-archive"),
	);
	return withArtifactActionLock(root, stage, importProducer, action, () => {
		const cached = readArtifactAction(root, stage, importProducer, action);
		if (
			cached?.outputs.length === files.length &&
			files.every((file) =>
				cached.outputs.some(
					(output) =>
						output.name === file.name &&
						output.digest === file.sha256 &&
						output.size === file.size,
				),
			)
		)
			return cached;

		const work = path.join(root, "work", "prebuilt-runtime");
		mkdirSync(work, { recursive: true });
		const temporary = mkdtempSync(path.join(work, "import-"));
		try {
			const publications = files.map((expected) => {
				const file = path.join(temporary, expected.name);
				copyFileSync(path.join(bundle.directory, expected.name), file);
				// Publish only the snapshot we verified, even if the package is being replaced.
				if (!matchesFile(file, expected)) throw new Error("prebuilt archive changed");
				return { name: expected.name, file };
			});
			return publishArtifactAction(root, stage, importProducer, action, publications);
		} catch {
			return undefined;
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
}
