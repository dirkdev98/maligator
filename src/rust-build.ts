import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
import { cargoCacheDirectory } from "./cache-root.ts";
import {
	hashDirectoryTrees,
	hashDirectoryTreesCached,
	legacyLocaleNameComparator,
	lexicalNameComparator,
} from "./file-tree.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { runNativeCommand } from "./native-command.ts";
import {
	importPrebuiltRuntimeAction,
	NATIVE_OUTPUT_PREFIX,
	prebuiltProductionRustDirectory,
	prebuiltRustKey,
	readPrebuiltRust,
	RUST_LIBRARY_OUTPUT,
} from "./prebuilt-runtime.ts";
import type { PrebuiltRuntime } from "./prebuilt-runtime.ts";
import { formatToolCommand, requireToolchain, toolArguments } from "./toolchain.ts";
import { buildWorkerCount } from "./worker-budget.ts";

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

function cachedRustSourceDigest(
	rustDirectory: string,
	cacheDirectory: string,
	compareNames = legacyLocaleNameComparator,
): string {
	const rustRoot = path.resolve(rustDirectory);
	const rootKey = hash("sha256", rustRoot, "hex").slice(0, 16);
	return hashDirectoryTreesCached(
		{ ...rustSourceHashOptions(rustRoot), compareNames },
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

export const RUST_PRODUCER = artifactProducer("rust-library", 2, "cargo-build");
const RUST_TARGET_PRODUCER = artifactProducer("rust-target", 1, "cargo-build");

type RustArchiveInputs = Pick<
	NativeBuildContext,
	"runtimeDirectory" | "cacheDirectory" | "environment"
> & {
	features: Pick<NativeBuildContext["features"], "primordialsLocked" | "realmsEnabled">;
};

export function portableRustSourceDigest(
	context: Pick<RustArchiveInputs, "runtimeDirectory" | "cacheDirectory">,
): string {
	return cachedRustSourceDigest(
		path.join(context.runtimeDirectory, "rust"),
		context.cacheDirectory,
		lexicalNameComparator,
	);
}

export function packagedProductionRust(
	context: RustArchiveInputs,
	target: string,
	ccTarget?: string,
): PrebuiltRuntime | undefined {
	const directory = prebuiltProductionRustDirectory(
		target,
		context.features,
		context.environment,
		ccTarget,
	);
	if (directory === undefined) return undefined;
	return readPrebuiltRust(
		directory,
		target,
		prebuiltRustKey(target, portableRustSourceDigest(context), RUST_PRODUCER),
	);
}

/**
 * Build-script libraries that leave the Rust archive and link only when one of
 * the listed Cargo features is selected. A reference from unused Rust code
 * still loads an archive member, and section GC cannot shed these members
 * afterwards: Ada's static initializers keep its C++ code and libc++ alive, and
 * ring's assembly objects have no subsections. Unlisted packages stay bundled.
 */
const NATIVE_COMPONENT_FEATURES: Readonly<Record<string, ReadonlyArray<string>>> = {
	"ada-url": ["url"],
	ring: ["tls", "node-crypto"],
};

/** Cargo inputs and content-addressed paths shared by every native feature selection. */
export interface RustBuildPlan {
	cacheKey: string;
	targetKey: string;
	targetDirectory: string;
	library: string;
	cargoArguments: Array<string>;
	nativeToolEnvironment: Readonly<Record<string, string>>;
}

/** A build-script static library published beside the Rust archive. */
export interface RustNativeComponent {
	name: string;
	packageName: string;
	library: string;
}

export interface RustArtifacts extends Partial<RustBuildPlan> {
	cacheKey: string;
	library: string;
	nativeComponents: ReadonlyArray<RustNativeComponent>;
	/** The Rust archive, the selected native components and their link flags. */
	linkArgs: Array<string>;
}

type RustLibraryAction = ReturnType<typeof publishArtifactAction>;

function cargoNativeToolEnvironment(context: NativeBuildContext): Record<string, string> {
	const environment: Record<string, string> = {
		CC: formatToolCommand(context.toolchain.tools.cc),
		AR: context.toolchain.tools.ar.path,
	};
	// cc-rs misparses "zig ar" once Zig is registered as the compiler wrapper below.
	const arArguments = context.toolchain.tools.ar.args ?? [];
	if (arArguments.length > 0) {
		environment.ARFLAGS = [...arArguments, context.environment.ARFLAGS]
			.filter((value) => value !== undefined && value !== "")
			.join(" ");
	}
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

/**
 * Resolve exact Cargo arguments and content-addressed paths from one native
 * context. Native builds compile every Cargo feature, so the archive is keyed by
 * sources, target and tools only; each link keeps what its C references reach.
 */
export function resolveRustArtifacts(context: NativeBuildContext): RustBuildPlan {
	const rustDirectory = path.join(context.runtimeDirectory, "rust");
	const cargoArguments = ["build", "--release", "--all-features"];
	if (context.toolchain.cross === true) {
		cargoArguments.push("--target", context.toolchain.rustTarget);
	}
	const nativeToolEnvironment = cargoNativeToolEnvironment(context);
	const inputs: RustArtifactKeyInputs = {
		cargoArguments,
		environmentFingerprint: context.environmentFingerprint,
		nativeToolEnvironment: Object.entries(nativeToolEnvironment).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		),
		sourceDigest: cachedRustSourceDigest(rustDirectory, context.cacheDirectory),
		toolchainFingerprint: context.toolchain.fingerprint,
		rustTarget: context.toolchain.rustTarget,
	};
	const targetKey = artifactActionKey(RUST_TARGET_PRODUCER, inputs);
	const targetDirectory = path.join(
		context.cacheDirectory,
		"work",
		"rust",
		targetKey,
		"target",
	);
	return {
		cacheKey: rustArtifactKey(inputs),
		targetKey,
		targetDirectory,
		library: path.join(
			targetDirectory,
			...(context.toolchain.cross === true ? [context.toolchain.rustTarget] : []),
			"release",
			RUST_LIBRARY_OUTPUT,
		),
		cargoArguments,
		nativeToolEnvironment,
	};
}

function resolvedRustArtifacts(
	context: NativeBuildContext,
	action: RustLibraryAction,
	prebuilt = false,
	plan?: RustBuildPlan,
): RustArtifacts {
	const library = artifactOutput(action, RUST_LIBRARY_OUTPUT).path;
	const nativeComponents = action.outputs.flatMap((output) =>
		output.name.startsWith(NATIVE_OUTPUT_PREFIX)
			? [
					{
						name: output.name,
						packageName: output.name.slice(NATIVE_OUTPUT_PREFIX.length).split(".")[0]!,
						library: output.path,
					},
				]
			: [],
	);
	const features = new Set(context.features.cargoFeatures);
	const {
		sectionGcLinkArgs,
		cxxLinkArgs,
		cxxStaticLinkArgs = [],
		linkerArgs = [],
		linkAllRustComponents = false,
	} = context.toolchain.probes;
	// Without section GC the linker keeps every loaded Rust function, and with
	// them their references into each component. GNU ld can also need those
	// references resolved before it discards the unused sections.
	const linkEveryComponent = sectionGcLinkArgs.length === 0 || linkAllRustComponents;
	const selected = ({ packageName }: RustNativeComponent) =>
		linkEveryComponent ||
		(NATIVE_COMPONENT_FEATURES[packageName]?.some((feature) => features.has(feature)) ??
			false);
	const componentLibraries = nativeComponents
		.filter(selected)
		.map((item) => item.library);
	const linkCxx = linkEveryComponent || features.has("url");
	// Zig's Ada archive uses the bundled libc++ ABI even if the host links libstdc++.
	const groupComponents = prebuilt && linkCxx && context.toolchain.platform === "linux";
	// BFD may extract Ada for a reference from dead Rust code. Its static
	// initializers then keep C++ symbols live even under --as-needed.
	const cxxRuntime =
		linkAllRustComponents && !features.has("url") && cxxStaticLinkArgs.length > 0
			? cxxStaticLinkArgs
			: cxxLinkArgs;
	const localCxx = linkAllRustComponents
		? ["-Wl,--push-state,--as-needed", ...cxxRuntime, "-Wl,--pop-state"]
		: cxxRuntime;
	return {
		...plan,
		cacheKey: action.action,
		library,
		nativeComponents,
		linkArgs: [
			library,
			...(groupComponents ? ["-Wl,--start-group"] : []),
			...componentLibraries,
			...(groupComponents ? ["-Wl,--end-group"] : []),
			...(linkCxx && !prebuilt ? localCxx : []),
			...linkerArgs,
			...sectionGcLinkArgs,
			...platformLinkArgs(
				context.toolchain.platform ?? process.platform,
				context.toolchain.cross === true,
			),
		],
	};
}

function cachedRustArtifacts(
	context: NativeBuildContext,
	action: RustLibraryAction,
	startedAt: number,
	prebuilt: boolean,
	plan?: RustBuildPlan,
): RustArtifacts {
	const artifacts = resolvedRustArtifacts(context, action, prebuilt, plan);
	context.onCacheEvent?.({ artifact: "rust", hit: true, path: artifacts.library });
	if (prebuilt) {
		context.onBuildPhase?.({
			phase: "rust prebuilt",
			durationMs: performance.now() - startedAt,
			cache: "hit",
			path: artifacts.library,
		});
	}
	context.onBuildPhase?.({
		phase: "rust",
		durationMs: performance.now() - startedAt,
		cache: "hit",
		path: artifacts.library,
	});
	return artifacts;
}

interface NativeComponentLibrary {
	packageName: string;
	archive: string;
}

/** The package name in either Cargo package-id format ("name 1.0 (source)" or "source#name@1.0"). */
function cargoPackageName(packageId: string): string | undefined {
	return /#([^@#]+)@/.exec(packageId)?.[1] ?? /^(\S+) \S+ \(/.exec(packageId)?.[1];
}

/**
 * Locate the static libraries that the listed packages' build scripts link.
 * Cargo replays the results of fresh build scripts, so this query runs after the
 * build and costs no compilation.
 */
function nativeComponentLibraries(
	plan: RustBuildPlan,
	cargo: { path: string; args: ReadonlyArray<string> },
	cwd: string,
	env: NodeJS.ProcessEnv,
): Array<NativeComponentLibrary> {
	const stdout = execFileSync(
		cargo.path,
		[...cargo.args, ...plan.cargoArguments, "--message-format=json"],
		{
			cwd,
			env,
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	const libraries: Array<NativeComponentLibrary> = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		const message = JSON.parse(line) as {
			reason?: string;
			package_id?: string;
			linked_libs?: Array<string>;
			linked_paths?: Array<string>;
		};
		if (message.reason !== "build-script-executed") continue;
		const packageName = cargoPackageName(message.package_id ?? "");
		if (packageName === undefined || !(packageName in NATIVE_COMPONENT_FEATURES))
			continue;
		const directories = (message.linked_paths ?? []).map((entry) =>
			entry.replace(/^(?:native|dependency|crate|framework|all)=/, ""),
		);
		for (const entry of message.linked_libs ?? []) {
			const name = /^static(?::[^=]*)?=(.+)$/.exec(entry)?.[1];
			if (name === undefined) continue;
			const archive = directories
				.map((directory) => path.join(directory, `lib${name}.a`))
				.find((candidate) => existsSync(candidate));
			if (archive === undefined) {
				throw new Error(`cargo reported ${entry} for ${packageName} without an archive`);
			}
			libraries.push({ packageName, archive });
		}
	}
	return libraries;
}

/**
 * Copy the Rust archive without the members rustc bundled from `libraries`.
 * Bundling keeps each member's bytes; the name stays or gains a hash prefix. So
 * every library member must match exactly one bundled member byte for byte.
 */
function separateNativeComponents(
	context: NativeBuildContext,
	plan: RustBuildPlan,
	libraries: ReadonlyArray<NativeComponentLibrary>,
): string {
	const directory = path.join(plan.targetDirectory, "maligator-native-components");
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const trimmed = path.join(directory, RUST_LIBRARY_OUTPUT);
	copyFileSync(plan.library, trimmed);
	if (libraries.length === 0) return trimmed;
	const ar = context.toolchain.tools.ar;
	const runAr = (args: Array<string>): Buffer =>
		execFileSync(ar.path, toolArguments(ar, args), {
			env: context.environment,
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	const members = (archive: string) =>
		runAr(["t", archive])
			.toString("utf8")
			.split("\n")
			.filter((name) => name !== "" && !name.startsWith("__.SYMDEF") && name !== "/");
	const bundled = members(trimmed);
	const removed: Array<string> = [];
	for (const { packageName, archive } of libraries) {
		for (const member of members(archive)) {
			const content = runAr(["p", archive, member]);
			const matches = bundled.filter(
				(name) =>
					(name === member || /^[0-9a-f]+-/.test(name.slice(0, -member.length))) &&
					name.endsWith(member) &&
					runAr(["p", trimmed, name]).equals(content),
			);
			if (matches.length !== 1) {
				throw new Error(
					`expected one bundled copy of ${packageName}'s ${member} in ${plan.library}, found ${matches.length}`,
				);
			}
			removed.push(matches[0]!);
		}
	}
	runAr(["ds", trimmed, ...removed]);
	return trimmed;
}

/** Build the Rust FFI static library with reusable, serialized Cargo work products. */
export function ensureRustArtifacts(
	input: NativeBuildContext,
	verbose = false,
	bundle?: PrebuiltRuntime,
): RustArtifacts {
	const startedAt = performance.now();
	const selected = input.toolchain;
	if (input.plan.mode === "production") {
		const packaged = packagedProductionRust(
			input,
			selected.rustTarget,
			selected.cross === true ? selected.rustTarget : selected.target,
		);
		if (packaged !== undefined) {
			const imported = importPrebuiltRuntimeAction(
				input.cacheDirectory,
				"rust-library",
				RUST_PRODUCER,
				packaged.manifest.rustKey,
				packaged,
			);
			if (imported !== undefined)
				return cachedRustArtifacts(input, imported, startedAt, true);
		}
	}
	// A package can be replaced after toolchain selection. Use the selected
	// C driver for a local build if the released archives are no longer intact.
	const context =
		selected.tools.cargo === undefined
			? {
					...input,
					toolchain: requireToolchain({
						cacheDirectory: input.cacheDirectory,
						env: {
							...input.environment,
							ZIG: selected.tools.zig?.path ?? input.environment.ZIG,
						},
						rustDir: path.join(input.runtimeDirectory, "rust"),
						target: selected.cross === true ? selected.rustTarget : undefined,
					}),
				}
			: input;
	const plan = resolveRustArtifacts(context);
	const local = readArtifactAction(
		context.cacheDirectory,
		"rust-library",
		RUST_PRODUCER,
		plan.cacheKey,
	);
	const prebuilt =
		local === undefined && bundle !== undefined
			? importPrebuiltRuntimeAction(
					context.cacheDirectory,
					"rust-library",
					RUST_PRODUCER,
					plan.cacheKey,
					bundle,
				)
			: undefined;
	const cached = local ?? prebuilt;
	if (cached !== undefined)
		return cachedRustArtifacts(context, cached, startedAt, prebuilt !== undefined, plan);
	const { cargo, rustc, cxx } = context.toolchain.tools;
	if (cargo === undefined || rustc === undefined || cxx === undefined)
		throw new Error(
			"building the Rust runtime requires Cargo, rustc, and a C++ compiler (run 'maligator doctor')",
		);
	context.onCacheEvent?.({ artifact: "rust", hit: false, path: plan.library });
	const published = withArtifactActionLock(
		context.cacheDirectory,
		"rust-library",
		RUST_PRODUCER,
		plan.cacheKey,
		() => {
			const raced = readArtifactAction(
				context.cacheDirectory,
				"rust-library",
				RUST_PRODUCER,
				plan.cacheKey,
			);
			if (raced !== undefined) return raced;
			return withArtifactActionLock(
				context.cacheDirectory,
				"rust-target",
				RUST_TARGET_PRODUCER,
				plan.targetKey,
				() => {
					const currentPath = context.environment.PATH ?? "";
					const cwd = path.join(context.runtimeDirectory, "rust");
					const env = {
						...context.environment,
						...plan.nativeToolEnvironment,
						PATH: `${path.dirname(cargo.path)}${path.delimiter}${currentPath}`,
						CARGO_HOME: cargoCacheDirectory(context.environment),
						CARGO_TARGET_DIR: plan.targetDirectory,
						CARGO_BUILD_JOBS: String(
							buildWorkerCount(context.environment, "CARGO_BUILD_JOBS", 8),
						),
						RUSTC: rustc.path,
					};
					const buildStartedAt = performance.now();
					runNativeCommand(
						context,
						cargo.path,
						toolArguments(cargo, plan.cargoArguments),
						{
							cwd,
							env,
							verbose,
						},
					);
					let librarySize = 0;
					try {
						const stats = statSync(plan.library);
						if (stats.isFile()) librarySize = stats.size;
					} catch {
						// Report the common failure below.
					}
					if (librarySize === 0) {
						throw new Error(`cargo completed without producing ${plan.library}`);
					}
					const libraries = nativeComponentLibraries(
						plan,
						{ path: cargo.path, args: cargo.args ?? [] },
						cwd,
						env,
					);
					const built = publishArtifactAction(
						context.cacheDirectory,
						"rust-library",
						RUST_PRODUCER,
						plan.cacheKey,
						[
							{
								name: RUST_LIBRARY_OUTPUT,
								file: separateNativeComponents(context, plan, libraries),
							},
							...libraries.map(({ packageName, archive }) => ({
								name: `${NATIVE_OUTPUT_PREFIX}${packageName}.${path.basename(archive)}`,
								file: archive,
							})),
						],
					);
					context.onBuildPhase?.({
						phase: "rust local build",
						durationMs: performance.now() - buildStartedAt,
						cache: "miss",
					});
					return built;
				},
			);
		},
	);
	const artifacts = resolvedRustArtifacts(context, published, false, plan);
	context.onBuildPhase?.({
		phase: "rust",
		durationMs: performance.now() - startedAt,
		cache: "miss",
		path: artifacts.library,
	});
	return artifacts;
}
