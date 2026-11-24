import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
	artifactActionKey,
	artifactDigest,
	artifactOutput,
	artifactProducer,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "./artifact-store.ts";
import {
	ccExtraFlags,
	runtimeOptimizationFlags,
	runtimeSectionFlags,
	sanitizerMode,
} from "./build-flags.ts";
import {
	compileArgumentsEmitDebugInfo,
	expandedGeneratedUnitDigest,
} from "./c-declaration-slice.ts";
import type { PreludeDeclarations } from "./c-declaration-slice.ts";
import { ensureCompilerArtifacts } from "./compiler-bake.ts";
import { hashDirectoryTrees, hashDirectoryTreesCached } from "./file-tree.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { normalizeRuntimeBuildArgument } from "./native-cache-identity.ts";
import { runNativeCommand, runNativeCommands } from "./native-command.ts";
import {
	importPrebuiltRuntimeAction,
	prebuiltRuntimeDirectory,
	prebuiltRuntimeIdentity,
	readPrebuiltRuntime,
	RUNTIME_ARCHIVES,
} from "./prebuilt-runtime.ts";
import {
	ensureRustArtifacts,
	portableRustSourceDigest,
	RUST_PRODUCER,
} from "./rust-build.ts";
import type { RustArtifacts } from "./rust-build.ts";
import { clangMajorVersion, toolArguments } from "./toolchain.ts";

const RUNTIME_OBJECT_PRODUCER = artifactProducer("runtime-object", 3, "cc");
const RUNTIME_ARCHIVE_PRODUCER = artifactProducer("runtime-archive", 6, "ar");
const EVAL_COMPONENT_PRODUCER = artifactProducer("eval-component", 1, "ar");

function runtimeSourceSnapshot(
	runtimeDirectory: string,
	cacheDirectory: string,
): { digest: string; version: string } {
	const root = path.resolve(runtimeDirectory);
	const llhttp = path.join(root, "vendor/llhttp");
	const sqlite = path.join(root, "vendor/sqlite");
	const manifestPath = path.join(
		cacheDirectory,
		"source-digests",
		`runtime-${artifactDigest(root).slice(0, 16)}.json`,
	);
	const { digest } = hashDirectoryTreesCached(
		{
			root,
			directories: [
				path.join(root, "src"),
				path.join(root, "rust/include"),
				...(existsSync(llhttp)
					? [path.join(llhttp, "include"), path.join(llhttp, "src")]
					: []),
				...(existsSync(sqlite) ? [sqlite] : []),
			],
			include: (entry) => /\.(?:c|h|inc)$/.test(entry.name),
		},
		manifestPath,
		"runtime-source-v2",
	);
	// File identities detect edits restored to their old text while projection was running.
	return { digest, version: artifactDigest(readFileSync(manifestPath)) };
}

/** Headers that generated application translation units compile against. */
export function runtimeHeaderHash(
	runtimeDirectory: string,
	cacheDirectory?: string,
): string {
	const root = path.resolve(runtimeDirectory);
	const llhttp = path.join(root, "vendor/llhttp/include");
	const sqlite = path.join(root, "vendor/sqlite");
	const options = {
		root,
		directories: [
			path.join(root, "src"),
			path.join(root, "rust/include"),
			...(existsSync(llhttp) ? [llhttp] : []),
			...(existsSync(sqlite) ? [sqlite] : []),
		],
		include: (entry: { name: string }) => /\.(?:h|inc)$/.test(entry.name),
	};
	if (cacheDirectory === undefined) return hashDirectoryTrees(options);
	return hashDirectoryTreesCached(
		options,
		path.join(
			cacheDirectory,
			"source-digests",
			`runtime-headers-${artifactDigest(root).slice(0, 16)}.json`,
		),
		"runtime-headers-v2",
	).digest;
}

/** Hash the transitive runtime-owned include closure of generated C headers. */
export function generatedHeaderDependencyHash(
	runtimeDirectory: string,
	headerFiles: ReadonlyArray<string>,
): string {
	const root = path.resolve(runtimeDirectory);
	const includeDirectories = [
		path.join(root, "src"),
		path.join(root, "src/host"),
		path.join(root, "src/runtime"),
		path.join(root, "rust/include"),
		path.join(root, "vendor/llhttp/include"),
		path.join(root, "vendor/sqlite"),
	].filter(existsSync);
	const files = new Map<string, string>();
	const resolveInclude = (name: string, parent?: string): string | undefined => {
		const candidates = [
			...(parent === undefined ? [] : [path.resolve(path.dirname(parent), name)]),
			...includeDirectories.map((directory) => path.resolve(directory, name)),
		];
		return candidates.find(
			(candidate) =>
				(candidate === root || candidate.startsWith(`${root}${path.sep}`)) &&
				existsSync(candidate) &&
				statSync(candidate).isFile(),
		);
	};
	const visit = (name: string, parent?: string): void => {
		const file = resolveInclude(name, parent);
		if (file === undefined || files.has(file)) return;
		const source = readFileSync(file, "utf-8");
		files.set(file, artifactDigest(source));
		for (const match of source.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
			visit(match[1]!, file);
		}
	};
	for (const header of headerFiles) visit(header);
	return artifactDigest(
		JSON.stringify(
			[...files]
				.map(([file, digest]) => [path.relative(root, file), digest] as const)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		),
	);
}

export function runtimeArtifactKey(inputs: {
	compileArguments: Array<string>;
	environmentFingerprint: string;
	sourceHash: string;
	toolchainFingerprint: string;
	target: string;
}): string {
	return artifactActionKey(RUNTIME_ARCHIVE_PRODUCER, {
		compileArguments: inputs.compileArguments,
		environmentFingerprint: inputs.environmentFingerprint,
		sourceHash: inputs.sourceHash,
		toolchainFingerprint: inputs.toolchainFingerprint,
		target: inputs.target,
	});
}

export interface RuntimeArchives {
	runtime: string;
	host: string;
	engine: string;
	/** Static archive link order: runtime, host, engine. */
	linkArgs: Array<string>;
}

export interface NativeArtifacts {
	c: RuntimeArchives;
	/** The eval component's archive, present only for `engine.eval: true`. */
	eval?: string;
	rust: RustArtifacts;
	/** Complete final-link order, including Rust and its platform libraries. */
	linkArgs: Array<string>;
}

interface RuntimeLayout {
	sourceDigest: string;
	flags: Array<string>;
	includeArguments: Array<string>;
	sqliteIncludeArguments: Array<string>;
	cacheKey: string;
	compileArguments: Array<string>;
	sourceVersion: string;
}

interface EvalComponentLayout extends RuntimeLayout {
	sources: Array<RuntimeSource>;
}

interface RuntimeSource {
	name: string;
	path: string;
	layer: "engine" | "host" | "runtime" | "eval";
	layerDirectory: string;
	logicalPath: string;
	includeArguments?: Array<string>;
	/** Overlay objects churn with compiler edits, so CI carries them without runtime objects. */
	objectStage?: "compiler-overlay-object";
}

export function compilerNativeOverlayEnabled(
	profileEnabled: boolean,
	environment: NodeJS.ProcessEnv,
): boolean {
	// Sanitizers cover the compiler wire through the VM; normal lanes cover its 40 MiB C companion.
	return !profileEnabled && sanitizerMode(environment) === "none";
}

function runtimeLayout(context: NativeBuildContext): RuntimeLayout {
	const platform = context.toolchain.platform ?? process.platform;
	const flags = [
		...ccExtraFlags(context.plan, context.environment, platform),
		...runtimeSectionFlags(platform, context.toolchain.probes.sectionGcLinkArgs),
		...context.features.cDefines,
		`-ffile-prefix-map=${context.runtimeDirectory}=<runtime>`,
	];
	const sourceRoot = path.join(context.runtimeDirectory, "src");
	const llhttpRoot = path.join(context.runtimeDirectory, "vendor/llhttp");
	const sqliteRoot = path.join(context.runtimeDirectory, "vendor/sqlite");
	const sqliteIncludeArguments = existsSync(sqliteRoot) ? ["-I", sqliteRoot] : [];
	const includeArguments = [
		"-I",
		sourceRoot,
		"-I",
		path.join(sourceRoot, "host"),
		"-I",
		path.join(sourceRoot, "runtime"),
		"-I",
		path.join(context.runtimeDirectory, "rust/include"),
		...(existsSync(llhttpRoot) ? ["-I", path.join(llhttpRoot, "include")] : []),
		...sqliteIncludeArguments,
	];
	const identityFlags = flags.map((flag) =>
		normalizeRuntimeBuildArgument(context.runtimeDirectory, flag),
	);
	const source = runtimeSourceSnapshot(context.runtimeDirectory, context.cacheDirectory);
	const compileArguments = [
		"-std=c2x",
		...identityFlags,
		...runtimeOptimizationFlags(context.environment),
		...includeArguments.map((argument) =>
			normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
		),
		"-c",
		"<source>",
		"-o",
		"<object>",
	];
	const cacheKey = runtimeArtifactKey({
		compileArguments,
		environmentFingerprint: context.environmentFingerprint,
		sourceHash: source.digest,
		toolchainFingerprint: context.toolchain.fingerprint,
		target: context.toolchain.target,
	});
	return {
		flags,
		includeArguments,
		sqliteIncludeArguments,
		cacheKey,
		compileArguments,
		sourceDigest: source.digest,
		sourceVersion: source.version,
	};
}

/**
 * The eval component: the baked compiler wire, its optional native overlay, and the
 * unit that registers them with the runtime. Only `engine.eval: true` builds it, so
 * the runtime archive's identity never includes the compiler.
 */
function evalComponentLayout(
	context: NativeBuildContext,
	runtime: RuntimeLayout,
): EvalComponentLayout | undefined {
	if (!context.features.evalEnabled) return undefined;
	if (context.compilerBake === undefined) {
		throw new Error("eval-enabled build requires an explicit compiler wire input");
	}
	const useNativeOverlay = compilerNativeOverlayEnabled(
		context.features.profileEnabled,
		context.environment,
	);
	const compiler = ensureCompilerArtifacts(
		useNativeOverlay || context.compilerBake.kind !== "source"
			? context.compilerBake
			: { ...context.compilerBake, bakeProgram: undefined },
	);
	const nativeSources = useNativeOverlay ? compiler.nativeSourcePaths : [];
	const nativeDigest = useNativeOverlay ? compiler.nativeDigest : undefined;
	if ((nativeDigest === undefined) !== (nativeSources.length === 0)) {
		throw new Error("native compiler manifest is missing its source set or digest");
	}
	const componentDirectory = path.join(context.runtimeDirectory, "src", "eval");
	const sources: Array<RuntimeSource> = [
		{
			name: "eval_component.c",
			path: path.join(componentDirectory, "eval_component.c"),
			layer: "eval",
			layerDirectory: componentDirectory,
			logicalPath: path.posix.join("<runtime>", "src", "eval", "eval_component.c"),
		},
		...nativeSources.map((source) => ({
			name: path.basename(source),
			path: source,
			layer: "eval" as const,
			layerDirectory: componentDirectory,
			logicalPath: path.posix.join("<eval-compiler>", path.basename(source)),
			objectStage: "compiler-overlay-object" as const,
		})),
	];
	return {
		...runtime,
		flags: [
			...runtime.flags,
			`-DMAL_COMPILER_WIRE="${compiler.wirePath}"`,
			...(nativeDigest === undefined
				? []
				: [
						"-DMAL_COMPILER_NATIVE=1",
						`-DMAL_COMPILER_WIRE_DIGEST="${compiler.wireDigest}"`,
					]),
		],
		sources,
		// The runtime key covers the component's own source, the flags and the tools.
		cacheKey: artifactActionKey(EVAL_COMPONENT_PRODUCER, {
			runtime: runtime.cacheKey,
			compilerWireDigest: compiler.wireDigest,
			compilerNativeDigest: nativeDigest,
		}),
	};
}

export function runtimeReleaseArchiveIdentity(
	context: NativeBuildContext,
	layout = runtimeLayout(context),
) {
	return prebuiltRuntimeIdentity({
		target: context.toolchain.rustTarget,
		flavour: context.features,
		compileArguments: layout.compileArguments,
		cSourceDigest: layout.sourceDigest,
		rustSourceDigest: portableRustSourceDigest(context),
		cArchiveProducer: RUNTIME_ARCHIVE_PRODUCER,
		rustArchiveProducer: RUST_PRODUCER,
	});
}

function runtimeSources(
	context: NativeBuildContext,
	layout: RuntimeLayout,
): Array<RuntimeSource> {
	const sourceRoot = path.join(context.runtimeDirectory, "src");
	const sources: Array<RuntimeSource> = [];
	for (const layer of ["engine", "host", "runtime"] as const) {
		const layerDirectory = layer === "engine" ? sourceRoot : path.join(sourceRoot, layer);
		for (const name of readdirSync(layerDirectory)
			.filter((entry) => entry.endsWith(".c"))
			.sort()) {
			sources.push({
				name,
				path: path.join(layerDirectory, name),
				layer,
				layerDirectory,
				logicalPath: path.posix.join(
					"<runtime>",
					"src",
					layer === "engine" ? "" : layer,
					name,
				),
			});
		}
	}
	const llhttpSource = path.join(context.runtimeDirectory, "vendor/llhttp/src");
	if (existsSync(llhttpSource)) {
		for (const name of readdirSync(llhttpSource)
			.filter((entry) => entry.endsWith(".c"))
			.sort()) {
			sources.push({
				name: `llhttp-${name}`,
				path: path.join(llhttpSource, name),
				layer: "host",
				layerDirectory: path.join(sourceRoot, "host"),
				logicalPath: path.posix.join("<runtime>", "vendor", "llhttp", "src", name),
			});
		}
	}
	const sqliteSource = path.join(context.runtimeDirectory, "vendor/sqlite/sqlite3.c");
	if (existsSync(sqliteSource)) {
		sources.push({
			name: "sqlite3.c",
			path: sqliteSource,
			layer: "host",
			layerDirectory: path.join(sourceRoot, "host"),
			includeArguments: layout.sqliteIncludeArguments,
			logicalPath: path.posix.join("<runtime>", "vendor", "sqlite", "sqlite3.c"),
		});
	}
	return sources;
}

function objectActionKey(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	source: RuntimeSource,
	preprocessedDigest: string,
): string {
	return artifactActionKey(RUNTIME_OBJECT_PRODUCER, {
		source: source.logicalPath,
		preprocessedDigest,
		arguments: runtimeObjectCodegenArguments(context, layout, source),
		environment: context.environmentFingerprint,
		cc: context.toolchain.ccFingerprint,
		target: context.toolchain.target,
	});
}

interface RuntimeObject {
	source: RuntimeSource;
	path: string;
	digest: string;
}

interface ProjectedRuntimeSource {
	source: RuntimeSource;
	digest: string;
	path: string;
}

function sourceIncludeArguments(
	layout: RuntimeLayout,
	source: RuntimeSource,
): Array<string> {
	return (
		source.includeArguments ?? [...layout.includeArguments, "-I", source.layerDirectory]
	);
}

function runtimeSourceCompileFlags(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	source: RuntimeSource,
): Array<string> {
	return source.objectStage === "compiler-overlay-object"
		? layout.flags
		: [...layout.flags, ...runtimeOptimizationFlags(context.environment)];
}

function runtimeObjectCodegenArguments(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	source: RuntimeSource,
): Array<string> {
	return [
		"-std=c2x",
		...runtimeSourceCompileFlags(context, layout, source)
			// Feature and GC macros, the compiler-wire include, and header search paths
			// have already been projected into the preprocessed source digest. Keep
			// every code-generation-affecting flag so optimization, sanitizer, LTO,
			// target, and debug variants can never share incompatible objects.
			.filter((argument) => !argument.startsWith("-DMAL_"))
			.map((argument) =>
				normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
			),
	];
}

function projectRuntimeSources(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	sources: Array<RuntimeSource>,
	directory: string,
	verbose: boolean,
): Array<ProjectedRuntimeSource> {
	const startedAt = performance.now();
	const preprocessedDirectory = path.join(directory, "preprocessed");
	mkdirSync(preprocessedDirectory, { recursive: true });
	const outputs = sources.map((source) => ({
		source,
		path: path.join(
			preprocessedDirectory,
			`${artifactDigest(source.path).slice(0, 12)}.i`,
		),
	}));
	runNativeCommands(
		context,
		outputs.map(({ source, path: output }) => ({
			tool: context.toolchain.tools.cc.path,
			args: toolArguments(context.toolchain.tools.cc, [
				"-std=c2x",
				...runtimeSourceCompileFlags(context, layout, source),
				...sourceIncludeArguments(layout, source),
				"-E",
				...(compileArgumentsEmitDebugInfo(layout.flags) ? [] : ["-P"]),
				source.path,
				"-o",
				output,
			]),
		})),
		{ verbose },
	);
	// Overlay units are generated like program units, so they are keyed by the prelude
	// declarations they reach; handwritten runtime sources keep their whole expansion.
	const sliced = !compileArgumentsEmitDebugInfo(layout.flags);
	const preludes = new Map<string, PreludeDeclarations>();
	const projected = outputs.map(({ source, path: output }) => ({
		source,
		path: output,
		digest:
			source.objectStage === "compiler-overlay-object" && sliced
				? expandedGeneratedUnitDigest(readFileSync(output, "utf8"), preludes)
				: artifactDigest(new Uint8Array(readFileSync(output))),
	}));
	context.onBuildPhase?.({
		phase: "runtime C projection",
		durationMs: performance.now() - startedAt,
		units: sources.length,
	});
	return projected;
}

function ensureRuntimeObjects(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	sources: Array<RuntimeSource>,
	directory: string,
	verbose: boolean,
): Array<RuntimeObject> {
	mkdirSync(directory, { recursive: true });
	const compiler = context.runtimeObjectCompiler ?? context.toolchain.tools.cc;
	const clangVersion = clangMajorVersion(compiler.version);
	const projected = projectRuntimeSources(context, layout, sources, directory, verbose);
	if (
		runtimeSourceSnapshot(context.runtimeDirectory, context.cacheDirectory).version !==
		layout.sourceVersion
	)
		throw new Error(
			"Runtime sources changed during preprocessing; no objects were published",
		);
	const results = new Map<string, RuntimeObject>();
	const pending = projected.flatMap(({ source, digest, path: projectedPath }) => {
		const action = objectActionKey(context, layout, source, digest);
		const cached = readArtifactAction(
			context.cacheDirectory,
			source.objectStage ?? "runtime-object",
			RUNTIME_OBJECT_PRODUCER,
			action,
		);
		if (cached !== undefined) {
			const output = artifactOutput(cached, "object.o");
			results.set(source.path, { source, path: output.path, digest: output.digest });
			return [];
		}
		const output = path.join(directory, `${artifactDigest(source.path).slice(0, 12)}.o`);
		return [{ source, action, output, projectedPath }];
	});
	const hits = sources.length - pending.length;
	if (hits > 0) {
		context.onBuildPhase?.({
			phase: "runtime C object reuse",
			durationMs: 0,
			units: hits,
		});
	}
	const compileStartedAt = performance.now();
	runNativeCommands(
		context,
		[...pending]
			.sort(
				(left, right) =>
					statSync(right.source.path).size - statSync(left.source.path).size,
			)
			.map(({ source, output, projectedPath }) => ({
				tool: compiler.path,
				args: toolArguments(compiler, [
					"-std=c2x",
					...runtimeSourceCompileFlags(context, layout, source),
					// Expansion loses macro provenance, so Clang warns on intentional macro parentheses.
					...(clangVersion === undefined ? [] : ["-Wno-parentheses-equality"]),
					// Older Clang expands high #embed bytes as large unsigned integers;
					// conversion to u8 restores the bytes but warns once per high byte.
					// https://github.com/llvm/llvm-project/issues/102798
					...(source.name === "eval_component.c" &&
					clangVersion !== undefined &&
					Number(clangVersion) < 20
						? ["-Wno-constant-conversion"]
						: []),
					"-c",
					// The .i suffix selects preprocessed C across drivers; compile the keyed snapshot.
					projectedPath,
					"-o",
					output,
				]),
			})),
		{ verbose },
	);
	if (pending.length > 0) {
		context.onBuildPhase?.({
			phase: "runtime C object compile",
			durationMs: performance.now() - compileStartedAt,
			units: pending.length,
		});
	}
	for (const { source, action, output } of pending) {
		const published = publishArtifactAction(
			context.cacheDirectory,
			source.objectStage ?? "runtime-object",
			RUNTIME_OBJECT_PRODUCER,
			action,
			[{ name: "object.o", file: output }],
		);
		const artifact = artifactOutput(published, "object.o");
		results.set(source.path, {
			source,
			path: artifact.path,
			digest: artifact.digest,
		});
	}
	return sources.map((source) => results.get(source.path)!);
}

function archivesFromAction(
	action: NonNullable<ReturnType<typeof readArtifactAction>>,
): RuntimeArchives {
	const runtime = artifactOutput(action, RUNTIME_ARCHIVES.runtime).path;
	const host = artifactOutput(action, RUNTIME_ARCHIVES.host).path;
	const engine = artifactOutput(action, RUNTIME_ARCHIVES.engine).path;
	return { runtime, host, engine, linkArgs: [runtime, host, engine] };
}

function buildRuntimeArchives(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	verbose: boolean,
): RuntimeArchives {
	const workRoot = path.join(context.cacheDirectory, "work", "runtime");
	mkdirSync(workRoot, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(workRoot, "build-"));
	try {
		const objects = ensureRuntimeObjects(
			context,
			layout,
			runtimeSources(context, layout),
			path.join(temporaryDirectory, "compiled"),
			verbose,
		);
		const publications: Array<{ name: string; file: string }> = [];
		for (const layer of ["engine", "host", "runtime"] as const) {
			const layerStartedAt = performance.now();
			const layerObjects = objects.filter((object) => object.source.layer === layer);
			const objectDirectory = path.join(temporaryDirectory, "objects", layer);
			mkdirSync(objectDirectory, { recursive: true });
			const materialized = layerObjects.map((object, index) => {
				const destination = path.join(
					objectDirectory,
					`${String(index).padStart(4, "0")}-${object.source.name.slice(0, -2)}.o`,
				);
				copyFileSync(object.path, destination);
				return destination;
			});
			const archiveName = RUNTIME_ARCHIVES[layer];
			const archive = path.join(temporaryDirectory, archiveName);
			runNativeCommand(
				context,
				context.toolchain.tools.ar.path,
				toolArguments(context.toolchain.tools.ar, ["rcs", archive, ...materialized]),
				{ verbose },
			);
			publications.push({ name: archiveName, file: archive });
			context.onBuildPhase?.({
				phase: `runtime C · ${layer}`,
				durationMs: performance.now() - layerStartedAt,
				units: layerObjects.length,
				path: archive,
			});
		}
		const published = publishArtifactAction(
			context.cacheDirectory,
			"runtime-archive",
			RUNTIME_ARCHIVE_PRODUCER,
			layout.cacheKey,
			publications,
		);
		return archivesFromAction(published);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

const EVAL_COMPONENT_ARCHIVE = "libmaligator_eval.a";

function buildEvalComponent(
	context: NativeBuildContext,
	layout: EvalComponentLayout,
	verbose: boolean,
): string {
	const workRoot = path.join(context.cacheDirectory, "work", "runtime");
	mkdirSync(workRoot, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(workRoot, "eval-"));
	try {
		const objects = ensureRuntimeObjects(
			context,
			layout,
			layout.sources,
			path.join(temporaryDirectory, "compiled"),
			verbose,
		);
		const objectDirectory = path.join(temporaryDirectory, "objects");
		mkdirSync(objectDirectory, { recursive: true });
		const materialized = objects.map((object, index) => {
			const destination = path.join(
				objectDirectory,
				`${String(index).padStart(4, "0")}-${object.source.name.slice(0, -2)}.o`,
			);
			copyFileSync(object.path, destination);
			return destination;
		});
		const archive = path.join(temporaryDirectory, EVAL_COMPONENT_ARCHIVE);
		runNativeCommand(
			context,
			context.toolchain.tools.ar.path,
			toolArguments(context.toolchain.tools.ar, ["rcs", archive, ...materialized]),
			{ verbose },
		);
		const published = publishArtifactAction(
			context.cacheDirectory,
			"eval-component",
			EVAL_COMPONENT_PRODUCER,
			layout.cacheKey,
			[{ name: EVAL_COMPONENT_ARCHIVE, file: archive }],
		);
		return artifactOutput(published, EVAL_COMPONENT_ARCHIVE).path;
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

/**
 * The eval component's link arguments. Nothing in the runtime references the
 * component, which registers itself from a constructor, so the link names one of
 * its symbols to load the registering member. Code compiled at run time carries no
 * host manifest, so the link also names the engines the policy lets it reach.
 */
function ensureEvalComponent(
	context: NativeBuildContext,
	runtime: RuntimeLayout,
	verbose: boolean,
): { archive: string; linkArgs: Array<string> } | undefined {
	const layout = evalComponentLayout(context, runtime);
	if (layout === undefined) return undefined;
	const load = () => {
		const cached = readArtifactAction(
			context.cacheDirectory,
			"eval-component",
			EVAL_COMPONENT_PRODUCER,
			layout.cacheKey,
		);
		return cached === undefined
			? undefined
			: artifactOutput(cached, EVAL_COMPONENT_ARCHIVE).path;
	};
	const archive =
		load() ??
		withArtifactActionLock(
			context.cacheDirectory,
			"eval-component",
			EVAL_COMPONENT_PRODUCER,
			layout.cacheKey,
			() => load() ?? buildEvalComponent(context, layout, verbose),
		);
	const prefix = (context.toolchain.platform ?? process.platform) === "darwin" ? "_" : "";
	const symbols = [
		"mal_compiler_wire_data",
		"mal_host_install_unicode_normalization",
		...(context.features.regexpEnabled ? ["mal_host_install_regexp"] : []),
	];
	return {
		archive,
		linkArgs: [...symbols.map((symbol) => `-Wl,-u,${prefix}${symbol}`), archive],
	};
}

/** Ensure the C and Rust runtime artifacts selected by one resolved context. */
export function ensureNativeArtifacts(
	context: NativeBuildContext,
	verbose = false,
): NativeArtifacts {
	const startedAt = performance.now();
	const layout = runtimeLayout(context);
	const directory = prebuiltRuntimeDirectory(context);
	const bundle =
		directory === undefined
			? undefined
			: readPrebuiltRuntime(
					directory,
					context.toolchain.rustTarget,
					runtimeReleaseArchiveIdentity(context, layout).key,
				);
	const local = readArtifactAction(
		context.cacheDirectory,
		"runtime-archive",
		RUNTIME_ARCHIVE_PRODUCER,
		layout.cacheKey,
	);
	const prebuilt =
		local === undefined && bundle !== undefined
			? importPrebuiltRuntimeAction(
					context.cacheDirectory,
					"runtime-archive",
					RUNTIME_ARCHIVE_PRODUCER,
					layout.cacheKey,
					bundle,
				)
			: undefined;
	const cached = local ?? prebuilt;
	const cacheHit = cached !== undefined;
	context.onCacheEvent?.({
		artifact: "runtime",
		hit: cacheHit,
		path: cached?.outputs[0]?.path ?? layout.cacheKey,
	});
	const c =
		cached === undefined
			? withArtifactActionLock(
					context.cacheDirectory,
					"runtime-archive",
					RUNTIME_ARCHIVE_PRODUCER,
					layout.cacheKey,
					() => {
						const raced = readArtifactAction(
							context.cacheDirectory,
							"runtime-archive",
							RUNTIME_ARCHIVE_PRODUCER,
							layout.cacheKey,
						);
						if (raced !== undefined) return archivesFromAction(raced);
						const buildStartedAt = performance.now();
						const built = buildRuntimeArchives(context, layout, verbose);
						context.onBuildPhase?.({
							phase: "runtime local build",
							durationMs: performance.now() - buildStartedAt,
							cache: "miss",
							path: built.runtime,
						});
						return built;
					},
				)
			: archivesFromAction(cached);
	if (prebuilt !== undefined) {
		context.onBuildPhase?.({
			phase: "runtime prebuilt",
			durationMs: performance.now() - startedAt,
			cache: "hit",
			path: c.runtime,
		});
	}
	context.onBuildPhase?.({
		phase: "runtime",
		durationMs: performance.now() - startedAt,
		cache: cacheHit ? "hit" : "miss",
		path: c.runtime,
	});
	const evalComponent = ensureEvalComponent(context, layout, verbose);
	const rust = ensureRustArtifacts(context, verbose, bundle);
	return {
		c,
		...(evalComponent === undefined ? {} : { eval: evalComponent.archive }),
		rust,
		// The component precedes the archives that resolve its runtime references.
		linkArgs: [...(evalComponent?.linkArgs ?? []), ...c.linkArgs, ...rust.linkArgs],
	};
}
