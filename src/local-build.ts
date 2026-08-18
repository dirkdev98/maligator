import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
	artifactActionKey,
	artifactDigest,
	artifactOutput,
	artifactProducer,
	materializeArtifact,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "./artifact-store.ts";
import { buildSuffix, ccExtraFlags } from "./build-flags.ts";
import { maligatorBuildDirectory } from "./cache-root.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { normalizeRuntimeBuildArgument } from "./native-cache-identity.ts";
import { runNativeCommand, runNativeCommands } from "./native-command.ts";
import { ensureNativeArtifacts } from "./runtime-build.ts";
import type { NativeArtifacts } from "./runtime-build.ts";
import { runtimeHeaderHash } from "./runtime-build.ts";
import { toolArguments } from "./toolchain.ts";

const BUILD_DIRECTORY = maligatorBuildDirectory();
const GENERATED_OBJECT_PRODUCER = artifactProducer("generated-object", 1, "cc");
const LINKED_BINARY_PRODUCER = artifactProducer("linked-binary", 1, "cc-link");

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
		`-ffile-prefix-map=${context.runtimeDirectory}=<runtime>`,
	];
}

interface GeneratedObjectInput {
	sourcePath: string;
	logicalPath: string;
	source: string;
}

interface PendingGeneratedObject {
	index: number;
	key: string;
	temporaryObject: string;
	sourcePath: string;
	sourceSize: number;
}

interface GeneratedObject {
	path: string;
	digest: string;
}

function ensureGeneratedObjects(
	context: NativeBuildContext,
	inputs: ReadonlyArray<GeneratedObjectInput>,
	compileArguments: Array<string>,
	verbose: boolean,
	onCacheEvent?: (event: { hit: boolean; path: string }) => void,
): Array<GeneratedObject> {
	const parent = path.join(context.cacheDirectory, "work", "generated-object");
	mkdirSync(parent, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(parent, "build-"));
	const results = new Array<GeneratedObject | undefined>(inputs.length);
	const cacheHits = new Array<boolean | undefined>(inputs.length);
	const pending: Array<PendingGeneratedObject> = [];
	const runtimeHeaders = runtimeHeaderHash(
		context.runtimeDirectory,
		context.features.nodeEnabled,
		context.cacheDirectory,
	);
	for (const [index, input] of inputs.entries()) {
		const key = artifactActionKey(GENERATED_OBJECT_PRODUCER, {
			logicalPath: input.logicalPath,
			source: artifactDigest(input.source),
			compileArguments: compileArguments.map((argument) =>
				normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
			),
			runtimeHeaders,
			environment: context.environmentFingerprint,
			toolchain: context.toolchain.fingerprint,
			target: context.toolchain.target,
		});
		const cached = readArtifactAction(
			context.cacheDirectory,
			"generated-object",
			GENERATED_OBJECT_PRODUCER,
			key,
		);
		if (cached !== undefined) {
			const output = artifactOutput(cached, "unit.o");
			results[index] = { path: output.path, digest: output.digest };
			cacheHits[index] = true;
			continue;
		}
		pending.push({
			index,
			key,
			temporaryObject: path.join(temporaryDirectory, `${String(index)}.o`),
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
						`-ffile-prefix-map=${path.dirname(entry.sourcePath)}=<generated>`,
						"-c",
						entry.sourcePath,
						"-o",
						entry.temporaryObject,
					]),
				})),
			{ verbose },
		);
		for (const entry of pending) {
			const published = publishArtifactAction(
				context.cacheDirectory,
				"generated-object",
				GENERATED_OBJECT_PRODUCER,
				entry.key,
				[{ name: "unit.o", file: entry.temporaryObject }],
			);
			const output = artifactOutput(published, "unit.o");
			results[entry.index] = { path: output.path, digest: output.digest };
			cacheHits[entry.index] = false;
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	return results.map((object, index) => {
		if (object === undefined) {
			throw new Error(`generated object result missing for ${inputs[index]?.sourcePath}`);
		}
		onCacheEvent?.({ hit: cacheHits[index]!, path: object.path });
		return object;
	});
}

/** Build the serialized-definition development driver. */
export function buildLoadDriver(
	verbose: boolean,
	compilerBake: CompilerBakeInput,
): string {
	const context = resolveNativeBuildContext({ compilerBake });
	return buildLocalBinary({
		context,
		name: "MaligatorLoad",
		cSource: '#include "vm.h"\n',
		verbose,
		mainFile: path.join(context.runtimeDirectory, "load_main.c"),
	}).binaryPath;
}

/** Build or restore the stable host-aware development wire runner. */
export function buildDevelopmentRunner(
	context: NativeBuildContext,
	verbose: boolean,
	cacheSuffix?: string,
): LocalBuildResult {
	return buildLocalBinary({
		context,
		name: "MaligatorDev",
		cSource: '#include "vm.h"\n',
		verbose,
		mainFile: path.join(context.runtimeDirectory, "dev_main.c"),
		cacheSuffix,
	});
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
		[
			...cPaths.map((sourcePath, index) => ({
				sourcePath,
				logicalPath: `<generated>/${String(index)}.c`,
				source: sources[index]!,
			})),
			{
				sourcePath: mainFile,
				logicalPath: normalizeRuntimeBuildArgument(context.runtimeDirectory, mainFile),
				source: readFileSync(mainFile, "utf-8"),
			},
		],
		compileArguments,
		options.verbose,
		options.onGeneratedObjectCacheEvent,
	);
	const mainObject = generatedObjects.at(-1)!;
	const objects = generatedObjects.slice(0, -1);
	context.onBuildPhase?.({
		phase: "generated C objects",
		durationMs: performance.now() - phaseStartedAt,
		units: objects.length + 1,
	});
	const linkArguments = toolArguments(context.toolchain.tools.cc, [
		...compileArguments,
		...objects.map((object) => object.path),
		mainObject.path,
		...artifacts.linkArgs,
		...(zigLinkTimeStrip ? context.toolchain.probes.stripArgs : []),
	]);
	const linkKey = artifactActionKey(LINKED_BINARY_PRODUCER, {
		compileArguments: compileArguments.map((argument) =>
			normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
		),
		objects: [...objects, mainObject].map((object) => object.digest),
		artifacts: artifacts.linkArgs.map((argument) =>
			argument.startsWith("-")
				? argument
				: artifactDigest(new Uint8Array(readFileSync(argument))),
		),
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
	});
	const cached = readArtifactAction(
		context.cacheDirectory,
		"linked-binary",
		LINKED_BINARY_PRODUCER,
		linkKey,
	);
	phaseStartedAt = performance.now();
	if (cached !== undefined) {
		const binary = artifactOutput(cached, "binary");
		context.onCacheEvent?.({ artifact: "binary", hit: true, path: binary.path });
		materializeArtifact(binary, binaryPath);
		context.onBuildPhase?.({
			phase: "link",
			durationMs: performance.now() - phaseStartedAt,
			cache: "hit",
			path: binary.path,
		});
		return { binaryPath, artifacts, context };
	}
	context.onCacheEvent?.({ artifact: "binary", hit: false, path: linkKey });
	withArtifactActionLock(
		context.cacheDirectory,
		"linked-binary",
		LINKED_BINARY_PRODUCER,
		linkKey,
		() => {
			const raced = readArtifactAction(
				context.cacheDirectory,
				"linked-binary",
				LINKED_BINARY_PRODUCER,
				linkKey,
			);
			if (raced !== undefined) {
				materializeArtifact(artifactOutput(raced, "binary"), binaryPath);
				return;
			}
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
				path: binaryPath,
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
					const stripStartedAt = performance.now();
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
						durationMs: performance.now() - stripStartedAt,
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
				const publishStartedAt = performance.now();
				const published = publishArtifactAction(
					context.cacheDirectory,
					"linked-binary",
					LINKED_BINARY_PRODUCER,
					linkKey,
					[{ name: "binary", file: binaryPath }],
				);
				context.onBuildPhase?.({
					phase: "publish binary",
					durationMs: performance.now() - publishStartedAt,
					path: artifactOutput(published, "binary").path,
				});
			}
		},
	);

	return { binaryPath, artifacts, context };
}
