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
import { platformLinkArgs, sanitizerMode, unwindTableCcFlags } from "./build-flags.ts";
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
	ADA_NO_EXCEPTIONS_OUTPUT,
	importPrebuiltRuntimeAction,
	NATIVE_OUTPUT_PREFIX,
	prebuiltRustDirectory,
	prebuiltRustKey,
	readPrebuiltRust,
	RUST_LIBRARY_OUTPUT,
	RUST_NO_STD_OUTPUT,
} from "./prebuilt-runtime.ts";
import type { PrebuiltRuntime } from "./prebuilt-runtime.ts";
import {
	formatToolCommand,
	requireToolchain,
	toolArguments,
	zigLibraryDirectory,
} from "./toolchain.ts";
import { buildWorkerCount } from "./worker-budget.ts";

export { resolvePathExecutable } from "./toolchain.ts";

function rustSourceHashOptions(rustRoot: string) {
	return {
		root: rustRoot,
		directories: [rustRoot],
		include: (entry: { name: string }) => /\.(?:rs|toml|lock|cpp)$/.test(entry.name),
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

export const RUST_PRODUCER = artifactProducer("rust-library", 7, "cargo-build");
const RUST_TARGET_PRODUCER = artifactProducer("rust-target", 1, "cargo-build");

type RustArchiveInputs = Pick<
	NativeBuildContext,
	"runtimeDirectory" | "cacheDirectory" | "environment"
>;

export function portableRustSourceDigest(
	context: Pick<RustArchiveInputs, "runtimeDirectory" | "cacheDirectory">,
): string {
	return cachedRustSourceDigest(
		path.join(context.runtimeDirectory, "rust"),
		context.cacheDirectory,
		lexicalNameComparator,
	);
}

export function packagedRuntimeRust(
	context: RustArchiveInputs,
	target: string,
	ccTarget?: string,
): PrebuiltRuntime | undefined {
	const directory = prebuiltRustDirectory(target, context.environment, ccTarget);
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

function adaNoExceptionsArchive(
	context: NativeBuildContext,
	directory: string,
	env: NodeJS.ProcessEnv,
	verbose: boolean,
): string | undefined {
	const {
		tools: { zig, cxx, ar },
		cross,
		platform,
	} = context.toolchain;
	const unwind = unwindTableCcFlags(platform ?? process.platform, env);
	if (!cross || zig === undefined || cxx === undefined || unwind.length === 0)
		return undefined;
	mkdirSync(directory, { recursive: true });
	const lib = zigLibraryDirectory(zig, env, directory);
	// Match Ada's exception mode in the library code reached through extern
	// templates, replaceable allocation operators and thread-safe statics.
	const sources = [
		"libcxx/src/string.cpp",
		"libcxx/src/new_helpers.cpp",
		"libcxxabi/src/abort_message.cpp",
		"libcxxabi/src/cxa_default_handlers.cpp",
		"libcxxabi/src/cxa_guard.cpp",
		"libcxxabi/src/cxa_handlers.cpp",
		"libcxxabi/src/cxa_virtual.cpp",
		"libcxxabi/src/private_typeinfo.cpp",
		"libcxxabi/src/stdlib_exception.cpp",
		"libcxxabi/src/stdlib_typeinfo.cpp",
	].map((file) => path.join(lib, file));
	if (sources.some((file) => !existsSync(file))) return undefined;
	sources.push(path.join(context.runtimeDirectory, "rust/cxx/ada_allocation.cpp"));
	const objects = sources.map((file) => {
		const object = path.join(directory, `${path.basename(file, ".cpp")}.o`);
		runNativeCommand(
			context,
			cxx.path,
			toolArguments(cxx, [
				"-std=c++20",
				"-O3",
				"-g0",
				"-DNDEBUG",
				"-ffunction-sections",
				"-fdata-sections",
				"-fno-exceptions",
				"-fno-sanitize=undefined",
				...unwind,
				"-D_LIBCPP_BUILDING_LIBRARY",
				"-D_LIBCXXABI_BUILDING_LIBRARY",
				"-D_LIBCXXABI_NO_EXCEPTIONS",
				"-I",
				path.join(lib, "libcxxabi/include"),
				"-I",
				path.join(lib, "libcxx/src"),
				"-c",
				file,
				"-o",
				object,
			]),
			{ cwd: directory, env, verbose },
		);
		return object;
	});
	const archive = path.join(directory, "libcxx-noexceptions.a");
	runNativeCommand(context, ar.path, toolArguments(ar, ["rcs", archive, ...objects]), {
		cwd: directory,
		env,
		verbose,
	});
	return archive;
}

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

function cargoNativeToolEnvironment(
	context: NativeBuildContext,
	unwindFlags: ReadonlyArray<string>,
): Record<string, string> {
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
	const cross = context.toolchain.cross === true;
	if (cross) {
		// The Zig command supplies its target in Zig syntax. Disabling cc-rs's
		// defaults avoids a second target flag, but also removes its release flags.
		environment.CC_KNOWN_WRAPPER_CUSTOM = path.basename(context.toolchain.tools.cc.path);
		environment.CRATE_CC_NO_DEFAULTS = "1";
	}
	if (cross || unwindFlags.length > 0) {
		const releaseFlags = cross
			? [
					`-O${context.environment.CARGO_PROFILE_RELEASE_OPT_LEVEL ?? "3"}`,
					"-DNDEBUG",
					"-ffunction-sections",
					"-fdata-sections",
				]
			: [];
		const flags = [...releaseFlags, ...unwindFlags];
		// Zig otherwise emits calls into UBSan from ordinary C and C++ builds.
		const zigFlags = cross ? ["-fno-sanitize=undefined"] : [];
		environment.CFLAGS = [...flags, context.environment.CFLAGS, ...zigFlags]
			.filter((value) => value !== undefined && value !== "")
			.join(" ");
		// The bundled Ada parser reports errors through its C API. Its exception
		// handlers are confined to the disabled std::regex URLPattern provider.
		environment.CXXFLAGS = [
			...flags,
			"-fno-exceptions",
			context.environment.CXXFLAGS,
			...zigFlags,
		]
			.filter((value) => value !== undefined && value !== "")
			.join(" ");
	}
	return environment;
}

function usesNoStdRust(context: NativeBuildContext): boolean {
	const { sectionGcLinkArgs, linkAllRustComponents } = context.toolchain.probes;
	const platform = context.toolchain.platform ?? process.platform;
	return (
		(platform === "linux" || platform === "darwin") &&
		!context.features.usesRustStd &&
		!context.features.evalEnabled &&
		!context.features.realmsEnabled &&
		sectionGcLinkArgs.length > 0 &&
		linkAllRustComponents !== true &&
		sanitizerMode(context.environment) === "none"
	);
}

/**
 * Resolve the shared Rust archive for this link. The compact archive keeps the
 * feature providers that can run without std. Section GC handles finer selection.
 */
export function resolveRustArtifacts(context: NativeBuildContext): RustBuildPlan {
	const rustDirectory = path.join(context.runtimeDirectory, "rust");
	const cargoArguments = [
		"build",
		"--release",
		...(usesNoStdRust(context)
			? [
					"--no-default-features",
					"--features",
					[
						"url",
						"regexp",
						"zlib",
						"node-crypto",
						...(context.features.usesRustIntl ? ["intl-full"] : []),
					].join(","),
				]
			: ["--all-features"]),
	];
	if (context.toolchain.cross === true) {
		cargoArguments.push("--target", context.toolchain.rustTarget);
	}
	const unwindFlags = unwindTableCcFlags(
		context.toolchain.platform ?? process.platform,
		context.environment,
	);
	const nativeToolEnvironment = cargoNativeToolEnvironment(context, unwindFlags);
	if (unwindFlags.length > 0) {
		const flag = "-Cforce-unwind-tables=no";
		const { CARGO_ENCODED_RUSTFLAGS, RUSTFLAGS } = context.environment;
		if (CARGO_ENCODED_RUSTFLAGS !== undefined) {
			nativeToolEnvironment.CARGO_ENCODED_RUSTFLAGS = CARGO_ENCODED_RUSTFLAGS
				? `${CARGO_ENCODED_RUSTFLAGS}\x1f${flag}`
				: flag;
		} else if (RUSTFLAGS !== undefined) {
			nativeToolEnvironment.RUSTFLAGS = RUSTFLAGS ? `${RUSTFLAGS} ${flag}` : flag;
		} else {
			cargoArguments.push(
				"--config",
				`target.${context.toolchain.rustTarget}.rustflags=["${flag}"]`,
			);
		}
	}
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
	const library =
		(!context.features.usesRustIntl &&
			usesNoStdRust(context) &&
			action.outputs.find(({ name }) => name === RUST_NO_STD_OUTPUT)?.path) ||
		artifactOutput(action, RUST_LIBRARY_OUTPUT).path;
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
	const platform = context.toolchain.platform ?? process.platform;
	const adaNoExceptions = nativeComponents.find(
		({ name }) => name === ADA_NO_EXCEPTIONS_OUTPUT,
	);
	const componentLibraries = nativeComponents
		.filter(selected)
		.filter(({ name }) => name !== ADA_NO_EXCEPTIONS_OUTPUT)
		.map((item) => item.library);
	const usesUrlParser = features.has("url");
	const linkCxx = linkEveryComponent || usesUrlParser;
	// The packaged Ada archive uses the libc++ ABI. ELF links its bundled
	// archives together, while macOS resolves that ABI through the link driver.
	const groupComponents = prebuilt && linkCxx && platform === "linux";
	// BFD may extract Ada for a reference from dead Rust code. Its static
	// initializers then keep C++ symbols live even under --as-needed.
	const cxxRuntime =
		linkAllRustComponents &&
		!context.features.usesHost &&
		!usesUrlParser &&
		cxxStaticLinkArgs.length > 0
			? cxxStaticLinkArgs
			: cxxLinkArgs;
	const localCxx = linkAllRustComponents
		? ["-Wl,--push-state,--as-needed", ...cxxRuntime, "-Wl,--pop-state"]
		: cxxRuntime;
	const cxx = prebuilt ? (platform === "darwin" ? ["-lc++"] : []) : localCxx;
	return {
		...plan,
		cacheKey: action.action,
		library,
		nativeComponents,
		linkArgs: [
			library,
			...(groupComponents ? ["-Wl,--start-group"] : []),
			...(linkCxx &&
			adaNoExceptions !== undefined &&
			unwindTableCcFlags(platform, context.environment).length > 0
				? [adaNoExceptions.library]
				: []),
			...componentLibraries,
			...(groupComponents ? ["-Wl,--end-group"] : []),
			...(linkCxx ? cxx : []),
			...linkerArgs,
			...sectionGcLinkArgs,
			...platformLinkArgs(platform, context.toolchain.cross === true),
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
	const packaged =
		bundle ??
		packagedRuntimeRust(
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
	const cached = readArtifactAction(
		context.cacheDirectory,
		"rust-library",
		RUST_PRODUCER,
		plan.cacheKey,
	);
	if (cached !== undefined)
		return cachedRustArtifacts(context, cached, startedAt, false, plan);
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
					const adaNoExceptions = libraries.some(
						({ packageName }) => packageName === "ada-url",
					)
						? adaNoExceptionsArchive(
								context,
								path.join(plan.targetDirectory, "libcxx-noexceptions"),
								env,
								verbose,
							)
						: undefined;
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
							...(adaNoExceptions === undefined
								? []
								: [{ name: ADA_NO_EXCEPTIONS_OUTPUT, file: adaNoExceptions }]),
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
