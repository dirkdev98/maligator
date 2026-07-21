import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { runtimeCcFlags } from "./build-flags.ts";
import { ensureCompilerWire } from "./compiler-bake.ts";
import { hashDirectoryTrees, legacyLocaleNameComparator } from "./file-tree.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { ensureRustArtifacts } from "./rust-build.ts";
import type { RustArtifacts } from "./rust-build.ts";

function runtimeSourceHash(runtimeDirectory: string): string {
	const root = path.resolve(runtimeDirectory);
	return hashDirectoryTrees({
		root,
		directories: [path.join(root, "src"), path.join(root, "rust/include")],
		include: (entry) => /\.[ch]$/.test(entry.name),
		compareNames: legacyLocaleNameComparator,
	});
}

export function runtimeArtifactKey(inputs: {
	compilerWireDigest?: string;
	compileArguments: Array<string>;
	environmentFingerprint: string;
	layerSourceDirectories: Array<string>;
	sourceHash: string;
	toolchainFingerprint: string;
	target: string;
}): string {
	return hash(
		"sha256",
		JSON.stringify({
			schema: 6,
			compilerWireDigest: inputs.compilerWireDigest,
			compileArguments: inputs.compileArguments,
			environmentFingerprint: inputs.environmentFingerprint,
			layerSourceDirectories: inputs.layerSourceDirectories,
			sourceHash: inputs.sourceHash,
			toolchainFingerprint: inputs.toolchainFingerprint,
			target: inputs.target,
		}),
		"hex",
	).slice(0, 24);
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

function runtimeArchives(buildDirectory: string): RuntimeArchives {
	const runtime = path.join(buildDirectory, "libMalRuntime.a");
	const host = path.join(buildDirectory, "libMalHost.a");
	const engine = path.join(buildDirectory, "libLibMaligator.a");
	return { runtime, host, engine, linkArgs: [runtime, host, engine] };
}

interface RuntimeLayout {
	buildDirectory: string;
	flags: Array<string>;
	includeArguments: Array<string>;
	cacheKey: string;
}

function runtimeLayout(context: NativeBuildContext): RuntimeLayout {
	let compilerWire: string | undefined;
	if (context.features.evalEnabled) {
		if (context.compilerBake === undefined) {
			throw new Error("eval-enabled build requires an explicit compiler wire input");
		}
		compilerWire = ensureCompilerWire(context.compilerBake);
	}
	const flags = [
		...runtimeCcFlags({}, context.plan, context.environment),
		...context.features.cDefines,
		...(compilerWire === undefined ? [] : [`-DMAL_COMPILER_WIRE="${compilerWire}"`]),
	];
	const sourceRoot = path.join(context.runtimeDirectory, "src");
	const includeArguments = [
		"-I",
		sourceRoot,
		"-I",
		path.join(sourceRoot, "host"),
		"-I",
		path.join(sourceRoot, "runtime"),
		"-I",
		path.join(context.runtimeDirectory, "rust/include"),
	];
	const identityFlags = flags.map((flag) =>
		flag.startsWith("-DMAL_COMPILER_WIRE=") ? "-DMAL_COMPILER_WIRE=<content>" : flag,
	);
	const cacheKey = runtimeArtifactKey({
		compilerWireDigest:
			compilerWire === undefined
				? undefined
				: hash("sha256", readFileSync(compilerWire), "hex"),
		compileArguments: [
			"-std=c2x",
			...identityFlags,
			...includeArguments,
			"-I",
			"<layer-source>",
			"-c",
			"<source>",
			"-o",
			"<object>",
		],
		environmentFingerprint: context.environmentFingerprint,
		layerSourceDirectories: [
			sourceRoot,
			path.join(sourceRoot, "host"),
			path.join(sourceRoot, "runtime"),
		],
		sourceHash: runtimeSourceHash(context.runtimeDirectory),
		toolchainFingerprint: context.toolchain.fingerprint,
		target: context.toolchain.target,
	});
	return {
		buildDirectory: path.join(context.cacheDirectory, "runtime", cacheKey),
		flags,
		includeArguments,
		cacheKey,
	};
}

const RUNTIME_MANIFEST = "artifact.json";
const ARCHIVE_NAMES = ["libMalRuntime.a", "libMalHost.a", "libLibMaligator.a"];

interface RuntimeArchiveManifest {
	name: string;
	size: number;
	digest: string;
}

function archiveManifest(buildDirectory: string): Array<RuntimeArchiveManifest> {
	return ARCHIVE_NAMES.map((name) => {
		const archive = path.join(buildDirectory, name);
		const stats = statSync(archive);
		if (!stats.isFile() || stats.size === 0)
			throw new Error(`invalid runtime archive: ${archive}`);
		return {
			name,
			size: stats.size,
			digest: hash("sha256", readFileSync(archive), "hex"),
		};
	});
}

function validRuntimeCache(buildDirectory: string, cacheKey: string): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(path.join(buildDirectory, RUNTIME_MANIFEST), "utf-8"),
		) as { schema?: unknown; cacheKey?: unknown; archives?: unknown };
		return (
			manifest.schema === 2 &&
			manifest.cacheKey === cacheKey &&
			JSON.stringify(manifest.archives) ===
				JSON.stringify(archiveManifest(buildDirectory))
		);
	} catch {
		return false;
	}
}

function discardInvalidRuntimeCache(buildDirectory: string, cacheKey: string): void {
	if (!existsSync(buildDirectory) || validRuntimeCache(buildDirectory, cacheKey)) return;
	const quarantineDirectory = mkdtempSync(
		path.join(path.dirname(buildDirectory), ".invalid-runtime-"),
	);
	const quarantine = path.join(quarantineDirectory, "artifact");
	try {
		renameSync(buildDirectory, quarantine);
		rmSync(quarantine, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	} finally {
		rmSync(quarantineDirectory, { recursive: true, force: true });
	}
}

function publishRuntimeCache(
	temporaryDirectory: string,
	buildDirectory: string,
	cacheKey: string,
): void {
	for (;;) {
		if (validRuntimeCache(buildDirectory, cacheKey)) {
			rmSync(temporaryDirectory, { recursive: true, force: true });
			return;
		}
		discardInvalidRuntimeCache(buildDirectory, cacheKey);
		try {
			renameSync(temporaryDirectory, buildDirectory);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
		}
	}
}

function buildRuntimeCache(
	context: NativeBuildContext,
	layout: RuntimeLayout,
	verbose: boolean,
): void {
	mkdirSync(path.dirname(layout.buildDirectory), { recursive: true });
	discardInvalidRuntimeCache(layout.buildDirectory, layout.cacheKey);
	if (validRuntimeCache(layout.buildDirectory, layout.cacheKey)) return;
	const temporaryDirectory = mkdtempSync(
		path.join(path.dirname(layout.buildDirectory), `${layout.cacheKey}.tmp-`),
	);
	try {
		const sourceRoot = path.join(context.runtimeDirectory, "src");
		const archives = runtimeArchives(temporaryDirectory);
		const layers = [
			{ name: "engine", source: sourceRoot, archive: archives.engine },
			{ name: "host", source: path.join(sourceRoot, "host"), archive: archives.host },
			{
				name: "runtime",
				source: path.join(sourceRoot, "runtime"),
				archive: archives.runtime,
			},
		];
		for (const layer of layers) {
			const objectDirectory = path.join(temporaryDirectory, "objects", layer.name);
			mkdirSync(objectDirectory, { recursive: true });
			const objects = readdirSync(layer.source)
				.filter((name) => name.endsWith(".c"))
				.sort()
				.map((name) => {
					const objectPath = path.join(objectDirectory, `${name.slice(0, -2)}.o`);
					execFileSync(
						context.toolchain.tools.cc.path,
						[
							"-std=c2x",
							...layout.flags,
							...layout.includeArguments,
							"-I",
							layer.source,
							"-c",
							path.join(layer.source, name),
							"-o",
							objectPath,
						],
						{ env: context.environment, stdio: verbose ? "inherit" : "pipe" },
					);
					return objectPath;
				});
			execFileSync(context.toolchain.tools.ar.path, ["rcs", layer.archive, ...objects], {
				env: context.environment,
				stdio: verbose ? "inherit" : "pipe",
			});
		}
		if (
			!archives.linkArgs.every((archive) => {
				const stats = statSync(archive);
				return stats.isFile() && stats.size > 0;
			})
		) {
			throw new Error("native archiver completed without producing all runtime archives");
		}
		writeFileSync(
			path.join(temporaryDirectory, RUNTIME_MANIFEST),
			JSON.stringify({
				schema: 2,
				cacheKey: layout.cacheKey,
				archives: archiveManifest(temporaryDirectory),
			}),
		);
		publishRuntimeCache(temporaryDirectory, layout.buildDirectory, layout.cacheKey);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

/** Ensure the C and Rust runtime artifacts selected by one resolved context. */
export function ensureNativeArtifacts(
	context: NativeBuildContext,
	verbose = false,
): NativeArtifacts {
	const layout = runtimeLayout(context);
	const cacheHit = validRuntimeCache(layout.buildDirectory, layout.cacheKey);
	context.onCacheEvent?.({
		artifact: "runtime",
		hit: cacheHit,
		path: layout.buildDirectory,
	});
	if (!cacheHit) buildRuntimeCache(context, layout, verbose);
	const rust = ensureRustArtifacts(context, verbose);
	const c = runtimeArchives(layout.buildDirectory);
	return { c, rust, linkArgs: [...c.linkArgs, ...rust.linkArgs] };
}
