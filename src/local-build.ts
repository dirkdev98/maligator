import { hash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
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
import { buildSuffix, ccExtraFlags } from "./build-flags.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { runNativeCommand, runNativeCommands } from "./native-command.ts";
import { ensureNativeArtifacts } from "./runtime-build.ts";
import type { NativeArtifacts } from "./runtime-build.ts";
import { toolArguments } from "./toolchain.ts";

const BUILD_DIRECTORY = ".cache/mal-build";

export type { BuildCacheEvent } from "./native-build-context.ts";

export interface LocalBuildOptions {
	/** The fully resolved native inputs shared by archive construction and this link. */
	context: NativeBuildContext;
	/** Base name for the emitted `.c` and linked binary. */
	name: string;
	/** Emitted translation unit(s), each of which must already include `vm.h`. */
	cSource: string | ReadonlyArray<string>;
	/** Surface compiler/archive output instead of swallowing it. */
	verbose: boolean;
	/** Entry-point translation unit; defaults to the test262 harness main. */
	mainFile?: string;
	/** Directory for the emitted `.c` and linked binary. */
	outDir?: string;
	/** Human-facing binary filename decoration only; never part of archive identity. */
	cacheSuffix?: string;
	onWarning?: (message: string) => void;
	onGeneratedObjectCacheEvent?: (event: { hit: boolean; path: string }) => void;
}

/** Exact inputs and output of one final native link. */
export interface LocalBuildResult {
	binaryPath: string;
	artifacts: NativeArtifacts;
	context: NativeBuildContext;
}

interface GeneratedObjectManifest {
	schema: 1;
	key: string;
	size: number;
	digest: string;
}

interface LinkedBinaryManifest {
	schema: 1;
	key: string;
	size: number;
	mode: number;
	digest: string;
}

function validLinkedBinary(directory: string, key: string): boolean {
	try {
		const binaryPath = path.join(directory, "binary");
		const manifest = JSON.parse(
			readFileSync(path.join(directory, "artifact.json"), "utf-8"),
		) as LinkedBinaryManifest;
		const stats = statSync(binaryPath);
		return (
			manifest.schema === 1 &&
			manifest.key === key &&
			stats.isFile() &&
			stats.size > 0 &&
			manifest.size === stats.size &&
			typeof manifest.mode === "number" &&
			manifest.digest === hash("sha256", readFileSync(binaryPath), "hex")
		);
	} catch {
		return false;
	}
}

function publishLinkedBinary(directory: string, key: string, binaryPath: string): void {
	const parent = path.dirname(directory);
	mkdirSync(parent, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(parent, ".build-"));
	try {
		const temporaryBinary = path.join(temporaryDirectory, "binary");
		copyFileSync(binaryPath, temporaryBinary);
		const stats = statSync(temporaryBinary);
		writeFileSync(
			path.join(temporaryDirectory, "artifact.json"),
			`${JSON.stringify({
				schema: 1,
				key,
				size: stats.size,
				mode: stats.mode & 0o777,
				digest: hash("sha256", readFileSync(temporaryBinary), "hex"),
			} satisfies LinkedBinaryManifest)}\n`,
		);
		try {
			renameSync(temporaryDirectory, directory);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				(code !== "EEXIST" && code !== "ENOTEMPTY") ||
				!validLinkedBinary(directory, key)
			) {
				throw error;
			}
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	if (!validLinkedBinary(directory, key)) {
		throw new Error(`linked binary cache publication failed: ${directory}`);
	}
}

function restoreLinkedBinary(directory: string, binaryPath: string): void {
	const cachedBinary = path.join(directory, "binary");
	const manifest = JSON.parse(
		readFileSync(path.join(directory, "artifact.json"), "utf-8"),
	) as LinkedBinaryManifest;
	rmSync(binaryPath, { force: true });
	copyFileSync(cachedBinary, binaryPath);
	if ((statSync(binaryPath).mode & 0o777) !== manifest.mode) {
		throw new Error(`linked binary cache restored the wrong file mode: ${binaryPath}`);
	}
}

function applicationCompileArguments(context: NativeBuildContext): Array<string> {
	return [
		"-std=c2x",
		...ccExtraFlags(
			context.plan,
			context.environment,
			context.toolchain.platform ?? process.platform,
		),
		...context.features.cDefines,
		"-I",
		path.join(context.runtimeDirectory, "src"),
		"-I",
		path.join(context.runtimeDirectory, "src/host"),
		"-I",
		path.join(context.runtimeDirectory, "src/runtime"),
		"-I",
		path.join(context.runtimeDirectory, "rust/include"),
		...(existsSync(path.join(context.runtimeDirectory, "vendor/llhttp/include"))
			? ["-I", path.join(context.runtimeDirectory, "vendor/llhttp/include")]
			: []),
	];
}

function validGeneratedObject(directory: string, key: string): boolean {
	try {
		const objectPath = path.join(directory, "unit.o");
		const manifest = JSON.parse(
			readFileSync(path.join(directory, "artifact.json"), "utf-8"),
		) as GeneratedObjectManifest;
		const stats = statSync(objectPath);
		return (
			manifest.schema === 1 &&
			manifest.key === key &&
			stats.isFile() &&
			stats.size > 0 &&
			manifest.size === stats.size &&
			manifest.digest === hash("sha256", readFileSync(objectPath), "hex")
		);
	} catch {
		return false;
	}
}

function generatedObjectDigest(objectPath: string): string {
	const manifest = JSON.parse(
		readFileSync(path.join(path.dirname(objectPath), "artifact.json"), "utf-8"),
	) as GeneratedObjectManifest;
	if (!validGeneratedObject(path.dirname(objectPath), manifest.key)) {
		throw new Error(`generated object became invalid before linking: ${objectPath}`);
	}
	return manifest.digest;
}

function stableRuntimeArgument(context: NativeBuildContext, argument: string): string {
	const relative = path.relative(context.runtimeDirectory, argument);
	if (relative === "") return "<runtime>";
	if (
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	) {
		return path.join("<runtime>", relative);
	}
	return argument;
}

interface GeneratedObjectInput {
	sourcePath: string;
	source: string;
}

interface PendingGeneratedObject {
	index: number;
	key: string;
	directory: string;
	objectPath: string;
	temporaryDirectory: string;
	temporaryObject: string;
	sourcePath: string;
	sourceSize: number;
}

function ensureGeneratedObjects(
	context: NativeBuildContext,
	runtimeArtifactPath: string,
	inputs: ReadonlyArray<GeneratedObjectInput>,
	compileArguments: Array<string>,
	verbose: boolean,
	onCacheEvent?: (event: { hit: boolean; path: string }) => void,
): Array<string> {
	const parent = path.join(context.cacheDirectory, "generated-c");
	const results: Array<string | undefined> = new Array(inputs.length);
	const cacheHits: Array<boolean | undefined> = new Array(inputs.length);
	const pending: Array<PendingGeneratedObject> = [];
	for (const [index, input] of inputs.entries()) {
		const key = hash(
			"sha256",
			JSON.stringify({
				schema: 1,
				sourcePath: input.sourcePath,
				source: hash("sha256", input.source, "hex"),
				compileArguments,
				runtimeArtifactDirectory: path.dirname(runtimeArtifactPath),
				environment: context.environmentFingerprint,
				toolchain: context.toolchain.fingerprint,
				target: context.toolchain.target,
			}),
			"hex",
		).slice(0, 32);
		const directory = path.join(parent, key);
		const objectPath = path.join(directory, "unit.o");
		if (validGeneratedObject(directory, key)) {
			results[index] = objectPath;
			cacheHits[index] = true;
			continue;
		}

		mkdirSync(parent, { recursive: true });
		rmSync(directory, { recursive: true, force: true });
		const temporaryDirectory = mkdtempSync(path.join(parent, ".build-"));
		pending.push({
			index,
			key,
			directory,
			objectPath,
			temporaryDirectory,
			temporaryObject: path.join(temporaryDirectory, "unit.o"),
			sourcePath: input.sourcePath,
			sourceSize: input.source.length,
		});
	}

	try {
		runNativeCommands(
			context,
			[...pending]
				.sort((left, right) => right.sourceSize - left.sourceSize)
				.map((entry) => ({
					tool: context.toolchain.tools.cc.path,
					args: toolArguments(context.toolchain.tools.cc, [
						...compileArguments,
						"-c",
						entry.sourcePath,
						"-o",
						entry.temporaryObject,
					]),
				})),
			{ verbose },
		);
		for (const entry of pending) {
			const bytes = readFileSync(entry.temporaryObject);
			if (bytes.length === 0) {
				throw new Error(`compiler produced an empty object: ${entry.sourcePath}`);
			}
			writeFileSync(
				path.join(entry.temporaryDirectory, "artifact.json"),
				`${JSON.stringify({
					schema: 1,
					key: entry.key,
					size: bytes.length,
					digest: hash("sha256", bytes, "hex"),
				} satisfies GeneratedObjectManifest)}\n`,
			);
			try {
				renameSync(entry.temporaryDirectory, entry.directory);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (
					(code !== "EEXIST" && code !== "ENOTEMPTY") ||
					!validGeneratedObject(entry.directory, entry.key)
				) {
					throw error;
				}
			}
			if (!validGeneratedObject(entry.directory, entry.key)) {
				throw new Error(`generated object cache publication failed: ${entry.objectPath}`);
			}
			results[entry.index] = entry.objectPath;
			cacheHits[entry.index] = false;
		}
	} finally {
		for (const entry of pending) {
			rmSync(entry.temporaryDirectory, { recursive: true, force: true });
		}
	}
	return results.map((objectPath, index) => {
		if (objectPath === undefined) {
			throw new Error(`generated object result missing for ${inputs[index]?.sourcePath}`);
		}
		onCacheEvent?.({ hit: cacheHits[index]!, path: objectPath });
		return objectPath;
	});
}

/** Build the serialized-definition development driver. */
export function buildLoadDriver(
	verbose: boolean,
	compilerBake: CompilerBakeInput,
): string {
	const context = resolveNativeBuildContext({ compilerBake });
	const artifacts = ensureNativeArtifacts(context, verbose);
	const binaryPath = path.join(
		BUILD_DIRECTORY,
		context.plan.mode,
		`MaligatorLoad${buildSuffix("", context.environment)}`,
	);
	mkdirSync(path.dirname(binaryPath), { recursive: true });

	runNativeCommand(
		context,
		context.toolchain.tools.cc.path,
		toolArguments(context.toolchain.tools.cc, [
			"-std=c2x",
			...ccExtraFlags(
				context.plan,
				context.environment,
				context.toolchain.platform ?? process.platform,
			),
			"-I",
			path.join(context.runtimeDirectory, "src"),
			"-I",
			path.join(context.runtimeDirectory, "src/host"),
			"-I",
			path.join(context.runtimeDirectory, "src/runtime"),
			"-I",
			path.join(context.runtimeDirectory, "rust/include"),
			...(existsSync(path.join(context.runtimeDirectory, "vendor/llhttp/include"))
				? ["-I", path.join(context.runtimeDirectory, "vendor/llhttp/include")]
				: []),
			path.join(context.runtimeDirectory, "load_main.c"),
			...artifacts.linkArgs,
			"-o",
			binaryPath,
		]),
		{ verbose },
	);

	return binaryPath;
}

/** Link emitted generated C into a standalone binary using one resolved context. */
export function buildLocalBinary(options: LocalBuildOptions): LocalBuildResult {
	const { context } = options;
	// Zig's strip capability is probed and applied through its cc driver because
	// objcopy can reject large LTO ELFs after succeeding on a small probe.
	const zigLinkTimeStrip =
		context.plan.strip && context.toolchain.tools.strip?.args?.[0] === "objcopy";
	const artifacts = ensureNativeArtifacts(context, options.verbose);
	const artifactName = `${options.name}${buildSuffix(
		options.cacheSuffix ?? "",
		context.environment,
	)}`;
	const outputDirectory =
		options.outDir ??
		path.join(
			BUILD_DIRECTORY,
			context.plan.mode,
			...(context.toolchain.cross === true ? [context.toolchain.rustTarget] : []),
		);
	mkdirSync(outputDirectory, { recursive: true });
	const cPath = path.join(outputDirectory, `${artifactName}.c`);
	const binaryPath = path.join(outputDirectory, artifactName);
	const sources =
		typeof options.cSource === "string" ? [options.cSource] : [...options.cSource];
	if (sources.length === 0) {
		throw new Error("buildLocalBinary requires at least one C translation unit");
	}
	let phaseStartedAt = performance.now();
	const cPaths = sources.map((source, index) => {
		const sourcePath =
			index === 0 ? cPath : path.join(outputDirectory, `${artifactName}.part-${index}.c`);
		writeFileSync(sourcePath, source);
		return sourcePath;
	});
	context.onBuildPhase?.({
		phase: "write generated C",
		durationMs: performance.now() - phaseStartedAt,
	});
	const compileArguments = applicationCompileArguments(context);
	phaseStartedAt = performance.now();
	const mainFile =
		options.mainFile ?? path.join(context.runtimeDirectory, "test262_main.c");
	const generatedObjects = ensureGeneratedObjects(
		context,
		artifacts.c.runtime,
		[
			...cPaths.map((sourcePath, index) => ({
				sourcePath,
				source: sources[index]!,
			})),
			{ sourcePath: mainFile, source: readFileSync(mainFile, "utf-8") },
		],
		compileArguments,
		options.verbose,
		options.onGeneratedObjectCacheEvent,
	);
	const mainObject = generatedObjects.at(-1)!;
	const objectPaths = generatedObjects.slice(0, -1);
	context.onBuildPhase?.({
		phase: "generated C objects",
		durationMs: performance.now() - phaseStartedAt,
		units: objectPaths.length + 1,
	});
	const linkArguments = toolArguments(context.toolchain.tools.cc, [
		...compileArguments,
		...objectPaths,
		mainObject,
		...artifacts.linkArgs,
		...(zigLinkTimeStrip ? context.toolchain.probes.stripArgs : []),
	]);
	const linkKey = hash(
		"sha256",
		JSON.stringify({
			schema: 1,
			compileArguments: compileArguments.map((argument) =>
				stableRuntimeArgument(context, argument),
			),
			objects: [...objectPaths, mainObject].map(generatedObjectDigest),
			artifacts: artifacts.linkArgs,
			zigStripArgs: zigLinkTimeStrip ? context.toolchain.probes.stripArgs : [],
			strip:
				context.plan.strip && !zigLinkTimeStrip
					? {
							tool: context.toolchain.tools.strip,
							args: context.toolchain.probes.stripArgs,
						}
					: undefined,
			environment: context.environmentFingerprint,
			toolchain: context.toolchain.fingerprint,
			target: context.toolchain.target,
		}),
		"hex",
	).slice(0, 32);
	const linkCacheDirectory = path.join(
		context.cacheDirectory,
		"linked-binaries",
		linkKey,
	);
	const cachedBinaryPath = path.join(linkCacheDirectory, "binary");
	phaseStartedAt = performance.now();
	if (validLinkedBinary(linkCacheDirectory, linkKey)) {
		context.onCacheEvent?.({ artifact: "binary", hit: true, path: cachedBinaryPath });
		restoreLinkedBinary(linkCacheDirectory, binaryPath);
		context.onBuildPhase?.({
			phase: "link",
			durationMs: performance.now() - phaseStartedAt,
			cache: "hit",
			path: cachedBinaryPath,
		});
		return { binaryPath, artifacts, context };
	}
	context.onCacheEvent?.({ artifact: "binary", hit: false, path: cachedBinaryPath });
	rmSync(linkCacheDirectory, { recursive: true, force: true });

	runNativeCommand(
		context,
		context.toolchain.tools.cc.path,
		[...linkArguments, "-o", binaryPath],
		{ verbose: options.verbose },
	);
	context.onBuildPhase?.({
		phase: "link",
		durationMs: performance.now() - phaseStartedAt,
		cache: "miss",
		path: cachedBinaryPath,
	});
	let cacheable = true;
	if (
		context.plan.strip &&
		context.toolchain.tools.strip !== undefined &&
		!zigLinkTimeStrip
	) {
		const objcopy =
			context.toolchain.tools.strip.args?.[0] === "objcopy"
				? `${binaryPath}.stripped`
				: undefined;
		try {
			phaseStartedAt = performance.now();
			runNativeCommand(
				context,
				context.toolchain.tools.strip.path,
				toolArguments(context.toolchain.tools.strip, [
					...context.toolchain.probes.stripArgs,
					binaryPath,
					...(objcopy === undefined ? [] : [objcopy]),
				]),
				{ verbose: options.verbose },
			);
			context.onBuildPhase?.({
				phase: "strip",
				durationMs: performance.now() - phaseStartedAt,
			});
			if (objcopy !== undefined) renameSync(objcopy, binaryPath);
		} catch (error) {
			cacheable = false;
			if (objcopy !== undefined) rmSync(objcopy, { force: true });
			options.onWarning?.(
				`production symbol stripping failed after a successful probe; leaving the binary unstripped: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (cacheable) {
		phaseStartedAt = performance.now();
		publishLinkedBinary(linkCacheDirectory, linkKey, binaryPath);
		context.onBuildPhase?.({
			phase: "publish binary",
			durationMs: performance.now() - phaseStartedAt,
			path: cachedBinaryPath,
		});
	}

	return { binaryPath, artifacts, context };
}
