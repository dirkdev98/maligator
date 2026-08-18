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
import { runtimeCcFlags } from "./build-flags.ts";
import { ensureCompilerWire } from "./compiler-bake.ts";
import {
	hashDirectoryTrees,
	hashDirectoryTreesCached,
	legacyLocaleNameComparator,
} from "./file-tree.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { normalizeRuntimeBuildArgument } from "./native-cache-identity.ts";
import { runNativeCommand, runNativeCommands } from "./native-command.ts";
import { ensureRustArtifacts } from "./rust-build.ts";
import type { RustArtifacts } from "./rust-build.ts";
import { toolArguments } from "./toolchain.ts";

const RUNTIME_OBJECT_PRODUCER = artifactProducer("runtime-object", 1, "cc");
const RUNTIME_ARCHIVE_PRODUCER = artifactProducer("runtime-archive", 1, "ar");

function runtimeSourceHash(
	runtimeDirectory: string,
	nodeEnabled: boolean,
	cacheDirectory: string,
): string {
	const root = path.resolve(runtimeDirectory);
	const llhttp = path.join(root, "vendor/llhttp");
	const sqlite = path.join(root, "vendor/sqlite");
	return hashDirectoryTreesCached(
		{
			root,
			directories: [
				path.join(root, "src"),
				path.join(root, "rust/include"),
				...(existsSync(llhttp)
					? [path.join(llhttp, "include"), path.join(llhttp, "src")]
					: []),
				...(nodeEnabled && existsSync(sqlite) ? [sqlite] : []),
			],
			include: (entry) => /\.[ch]$/.test(entry.name),
			compareNames: legacyLocaleNameComparator,
		},
		path.join(
			cacheDirectory,
			"source-digests",
			`runtime-${nodeEnabled ? "node" : "base"}-${artifactDigest(root).slice(0, 16)}.json`,
		),
		"runtime-source-v1",
	).digest;
}

/** Headers that generated application translation units compile against. */
export function runtimeHeaderHash(
	runtimeDirectory: string,
	nodeEnabled: boolean,
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
			...(nodeEnabled && existsSync(sqlite) ? [sqlite] : []),
		],
		include: (entry: { name: string }) => entry.name.endsWith(".h"),
		compareNames: legacyLocaleNameComparator,
	};
	if (cacheDirectory === undefined) return hashDirectoryTrees(options);
	return hashDirectoryTreesCached(
		options,
		path.join(
			cacheDirectory,
			"source-digests",
			`runtime-headers-${nodeEnabled ? "node" : "base"}-${artifactDigest(root).slice(0, 16)}.json`,
		),
		"runtime-headers-v1",
	).digest;
}

export function runtimeArtifactKey(inputs: {
	compilerWireDigest?: string;
	compileArguments: Array<string>;
	environmentFingerprint: string;
	sourceHash: string;
	toolchainFingerprint: string;
	target: string;
}): string {
	return artifactActionKey(RUNTIME_ARCHIVE_PRODUCER, {
		compilerWireDigest: inputs.compilerWireDigest,
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
	rust: RustArtifacts;
	/** Complete final-link order, including Rust and its platform libraries. */
	linkArgs: Array<string>;
}

interface RuntimeLayout {
	flags: Array<string>;
	includeArguments: Array<string>;
	sqliteIncludeArguments: Array<string>;
	cacheKey: string;
	compilerWireDigest?: string;
}

interface RuntimeSource {
	name: string;
	path: string;
	layer: "engine" | "host" | "runtime";
	layerDirectory: string;
	includeArguments?: Array<string>;
}

function runtimeLayout(context: NativeBuildContext): RuntimeLayout {
	let compilerWire: string | undefined;
	if (context.features.evalEnabled) {
		if (context.compilerBake === undefined) {
			throw new Error("eval-enabled build requires an explicit compiler wire input");
		}
		compilerWire = ensureCompilerWire(context.compilerBake);
	}
	const compilerWireDigest =
		compilerWire === undefined
			? undefined
			: artifactDigest(new Uint8Array(readFileSync(compilerWire)));
	const flags = [
		...runtimeCcFlags(
			{},
			context.plan,
			context.environment,
			context.toolchain.platform ?? process.platform,
		),
		...context.features.cDefines,
		...(compilerWire === undefined ? [] : [`-DMAL_COMPILER_WIRE="${compilerWire}"`]),
		`-ffile-prefix-map=${context.runtimeDirectory}=<runtime>`,
	];
	const sourceRoot = path.join(context.runtimeDirectory, "src");
	const llhttpRoot = path.join(context.runtimeDirectory, "vendor/llhttp");
	const sqliteRoot = path.join(context.runtimeDirectory, "vendor/sqlite");
	const sqliteIncludeArguments =
		context.features.nodeEnabled && existsSync(sqliteRoot) ? ["-I", sqliteRoot] : [];
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
		flag.startsWith("-DMAL_COMPILER_WIRE=")
			? "-DMAL_COMPILER_WIRE=<content>"
			: normalizeRuntimeBuildArgument(context.runtimeDirectory, flag),
	);
	const cacheKey = runtimeArtifactKey({
		compilerWireDigest,
		compileArguments: [
			"-std=c2x",
			...identityFlags,
			...includeArguments.map((argument) =>
				normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
			),
			"-c",
			"<source>",
			"-o",
			"<object>",
		],
		environmentFingerprint: context.environmentFingerprint,
		sourceHash: runtimeSourceHash(
			context.runtimeDirectory,
			context.features.nodeEnabled,
			context.cacheDirectory,
		),
		toolchainFingerprint: context.toolchain.fingerprint,
		target: context.toolchain.target,
	});
	return {
		flags,
		includeArguments,
		sqliteIncludeArguments,
		cacheKey,
		compilerWireDigest,
	};
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
			});
		}
	}
	const sqliteSource = path.join(context.runtimeDirectory, "vendor/sqlite/sqlite3.c");
	if (context.features.nodeEnabled && existsSync(sqliteSource)) {
		sources.push({
			name: "sqlite3.c",
			path: sqliteSource,
			layer: "host",
			layerDirectory: path.join(sourceRoot, "host"),
			includeArguments: layout.sqliteIncludeArguments,
		});
	}
	return sources;
}

function objectActionKey(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	source: RuntimeSource,
	headerDigest: string,
): string {
	const includeArguments = source.includeArguments ?? [
		...layout.includeArguments,
		"-I",
		source.layerDirectory,
	];
	return artifactActionKey(RUNTIME_OBJECT_PRODUCER, {
		source: path.posix.join(
			"<runtime>",
			...path.relative(context.runtimeDirectory, source.path).split(path.sep),
		),
		sourceDigest: artifactDigest(new Uint8Array(readFileSync(source.path))),
		headerDigest,
		compilerWireDigest: layout.compilerWireDigest,
		arguments: [
			"-std=c2x",
			...layout.flags.map((argument) =>
				normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
			),
			...includeArguments.map((argument) =>
				normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
			),
		],
		environment: context.environmentFingerprint,
		toolchain: context.toolchain.fingerprint,
		target: context.toolchain.target,
	});
}

interface RuntimeObject {
	source: RuntimeSource;
	path: string;
	digest: string;
}

function ensureRuntimeObjects(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	directory: string,
	verbose: boolean,
): Array<RuntimeObject> {
	mkdirSync(directory, { recursive: true });
	const headerDigest = runtimeHeaderHash(
		context.runtimeDirectory,
		context.features.nodeEnabled,
		context.cacheDirectory,
	);
	const sources = runtimeSources(context, layout);
	const results = new Map<string, RuntimeObject>();
	const pending = sources.flatMap((source) => {
		const action = objectActionKey(context, layout, source, headerDigest);
		const cached = readArtifactAction(
			context.cacheDirectory,
			"runtime-object",
			RUNTIME_OBJECT_PRODUCER,
			action,
		);
		if (cached !== undefined) {
			const output = artifactOutput(cached, "object.o");
			results.set(source.path, { source, path: output.path, digest: output.digest });
			return [];
		}
		const output = path.join(directory, `${artifactDigest(source.path).slice(0, 12)}.o`);
		return [{ source, action, output }];
	});
	runNativeCommands(
		context,
		[...pending]
			.sort(
				(left, right) =>
					statSync(right.source.path).size - statSync(left.source.path).size,
			)
			.map(({ source, output }) => ({
				tool: context.toolchain.tools.cc.path,
				args: toolArguments(context.toolchain.tools.cc, [
					"-std=c2x",
					...layout.flags,
					...(source.includeArguments ?? [
						...layout.includeArguments,
						"-I",
						source.layerDirectory,
					]),
					"-c",
					source.path,
					"-o",
					output,
				]),
			})),
		{ verbose },
	);
	for (const { source, action, output } of pending) {
		const published = publishArtifactAction(
			context.cacheDirectory,
			"runtime-object",
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
	const runtime = artifactOutput(action, "libMalRuntime.a").path;
	const host = artifactOutput(action, "libMalHost.a").path;
	const engine = artifactOutput(action, "libLibMaligator.a").path;
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
			const archiveName =
				layer === "engine"
					? "libLibMaligator.a"
					: layer === "host"
						? "libMalHost.a"
						: "libMalRuntime.a";
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

/** Ensure the C and Rust runtime artifacts selected by one resolved context. */
export function ensureNativeArtifacts(
	context: NativeBuildContext,
	verbose = false,
): NativeArtifacts {
	const startedAt = performance.now();
	const layout = runtimeLayout(context);
	const cached = readArtifactAction(
		context.cacheDirectory,
		"runtime-archive",
		RUNTIME_ARCHIVE_PRODUCER,
		layout.cacheKey,
	);
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
						return raced === undefined
							? buildRuntimeArchives(context, layout, verbose)
							: archivesFromAction(raced);
					},
				)
			: archivesFromAction(cached);
	context.onBuildPhase?.({
		phase: "runtime",
		durationMs: performance.now() - startedAt,
		cache: cacheHit ? "hit" : "miss",
		path: c.runtime,
	});
	const rust = ensureRustArtifacts(context, verbose);
	return { c, rust, linkArgs: [...c.linkArgs, ...rust.linkArgs] };
}
