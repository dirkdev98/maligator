import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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
import type { NativeCommandMeasurement } from "./native-command.ts";
import { ensureNativeArtifacts } from "./runtime-build.ts";
import type { NativeArtifacts } from "./runtime-build.ts";
import { runtimeHeaderHash } from "./runtime-build.ts";
import { toolArguments } from "./toolchain.ts";

const BUILD_DIRECTORY = maligatorBuildDirectory();
const GENERATED_OBJECT_PRODUCER = artifactProducer("generated-object", 1, "cc");
const LINKED_BINARY_PRODUCER = artifactProducer("linked-binary", 1, "cc-link");

function runnerWorkDirectory(context: NativeBuildContext): string {
	return path.join(
		context.cacheDirectory,
		"work",
		"local-runner",
		String(process.pid),
		...(context.toolchain.cross === true ? [context.toolchain.rustTarget] : []),
	);
}

export type { BuildCacheEvent } from "./native-build-context.ts";

export interface GeneratedObjectMeasurement {
	unit: string;
	role: "generated" | "driver";
	cache: "hit" | "miss";
	sourceBytes: number;
	objectBytes: number;
	compileDurationMs: number | null;
	userCpuMs: number | null;
	systemCpuMs: number | null;
	peakRssBytes?: number;
	path: string;
}

export interface LocalBuildMeasurements {
	objects: ReadonlyArray<GeneratedObjectMeasurement>;
	cToObjectDurationMs: number;
	linkDurationMs: number;
	linkCache: "hit" | "miss";
}

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
	onGeneratedObject?: (event: GeneratedObjectMeasurement) => void;
}

/** Exact inputs and output of one final native link. */
export interface LocalBuildResult {
	binaryPath: string;
	artifacts: NativeArtifacts;
	context: NativeBuildContext;
	measurements: LocalBuildMeasurements;
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
	role: GeneratedObjectMeasurement["role"];
}

interface PendingGeneratedObject {
	index: number;
	key: string;
	temporaryObject: string;
	sourcePath: string;
	sourceBytes: number;
	measurement?: NativeCommandMeasurement;
}

interface GeneratedObject {
	path: string;
	digest: string;
	measurement: GeneratedObjectMeasurement;
}

function ensureGeneratedObjects(
	context: NativeBuildContext,
	inputs: ReadonlyArray<GeneratedObjectInput>,
	compileArguments: Array<string>,
	verbose: boolean,
	onObject?: (event: GeneratedObjectMeasurement) => void,
): Array<GeneratedObject> {
	const parent = path.join(context.cacheDirectory, "work", "generated-object");
	mkdirSync(parent, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(parent, "build-"));
	const results = new Array<GeneratedObject | undefined>(inputs.length);
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
			results[index] = {
				path: output.path,
				digest: output.digest,
				measurement: {
					unit: input.logicalPath,
					role: input.role,
					cache: "hit",
					sourceBytes: Buffer.byteLength(input.source),
					objectBytes: statSync(output.path).size,
					compileDurationMs: null,
					userCpuMs: null,
					systemCpuMs: null,
					path: output.path,
				},
			};
			continue;
		}
		pending.push({
			index,
			key,
			temporaryObject: path.join(temporaryDirectory, `${String(index)}.o`),
			sourcePath: input.sourcePath,
			sourceBytes: Buffer.byteLength(input.source),
		});
	}

	try {
		const orderedPending = [...pending].sort(
			(left, right) => right.sourceBytes - left.sourceBytes,
		);
		const measurements = runNativeCommands(
			context,
			orderedPending.map((entry) => ({
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
			{ verbose, measureResources: true },
		);
		for (const [index, entry] of orderedPending.entries()) {
			const measurement = measurements[index];
			if (measurement === undefined) {
				throw new Error(`generated object measurement missing for ${entry.sourcePath}`);
			}
			entry.measurement = measurement;
		}
		for (const entry of pending) {
			const measurement = entry.measurement;
			if (measurement === undefined) {
				throw new Error(`generated object measurement missing for ${entry.sourcePath}`);
			}
			const published = publishArtifactAction(
				context.cacheDirectory,
				"generated-object",
				GENERATED_OBJECT_PRODUCER,
				entry.key,
				[{ name: "unit.o", file: entry.temporaryObject }],
			);
			const output = artifactOutput(published, "unit.o");
			const input = inputs[entry.index]!;
			results[entry.index] = {
				path: output.path,
				digest: output.digest,
				measurement: {
					unit: input.logicalPath,
					role: input.role,
					cache: "miss",
					sourceBytes: entry.sourceBytes,
					objectBytes: statSync(output.path).size,
					compileDurationMs: measurement.durationMs,
					userCpuMs: measurement.userCpuMs,
					systemCpuMs: measurement.systemCpuMs,
					...(measurement.peakRssBytes === undefined
						? {}
						: { peakRssBytes: measurement.peakRssBytes }),
					path: output.path,
				},
			};
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	return results.map((object, index) => {
		if (object === undefined) {
			throw new Error(`generated object result missing for ${inputs[index]?.sourcePath}`);
		}
		onObject?.(object.measurement);
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
		outDir: runnerWorkDirectory(context),
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
		outDir: runnerWorkDirectory(context),
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
		units: sources.length,
		bytes: sources.reduce((total, source) => total + Buffer.byteLength(source), 0),
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
				role: "generated" as const,
			})),
			{
				sourcePath: mainFile,
				logicalPath: normalizeRuntimeBuildArgument(context.runtimeDirectory, mainFile),
				source: readFileSync(mainFile, "utf-8"),
				role: "driver" as const,
			},
		],
		compileArguments,
		options.verbose,
		options.onGeneratedObject,
	);
	const mainObject = generatedObjects.at(-1)!;
	const objects = generatedObjects.slice(0, -1);
	const cToObjectDurationMs = performance.now() - phaseStartedAt;
	context.onBuildPhase?.({
		phase: "generated C objects",
		durationMs: cToObjectDurationMs,
		units: objects.length + 1,
		bytes: [...objects, mainObject].reduce(
			(total, object) => total + statSync(object.path).size,
			0,
		),
	});
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
		const linkDurationMs = performance.now() - phaseStartedAt;
		context.onBuildPhase?.({
			phase: "link",
			durationMs: linkDurationMs,
			cache: "hit",
			path: binary.path,
		});
		return {
			binaryPath,
			artifacts,
			context,
			measurements: {
				objects: generatedObjects.map((object) => object.measurement),
				cToObjectDurationMs,
				linkDurationMs,
				linkCache: "hit",
			},
		};
	}
	context.onCacheEvent?.({ artifact: "binary", hit: false, path: linkKey });
	let linkDurationMs = 0;
	let linkCache: "hit" | "miss" = "miss";
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
				linkCache = "hit";
				linkDurationMs = performance.now() - phaseStartedAt;
				context.onBuildPhase?.({
					phase: "link",
					durationMs: linkDurationMs,
					cache: "hit",
					path: binaryPath,
				});
				return;
			}
			const linkWorkRoot = path.join(context.cacheDirectory, "work", "link");
			mkdirSync(linkWorkRoot, { recursive: true });
			const linkDirectory = mkdtempSync(path.join(linkWorkRoot, "inputs-"));
			try {
				const materializedObjects = [...objects, mainObject].map((object, index) => {
					const destination = path.join(
						linkDirectory,
						`${String(index).padStart(4, "0")}.o`,
					);
					copyFileSync(object.path, destination, constants.COPYFILE_FICLONE);
					return destination;
				});
				let archiveIndex = 0;
				const materializedArtifacts = artifacts.linkArgs.map((argument) => {
					if (argument.startsWith("-")) return argument;
					const destination = path.join(
						linkDirectory,
						`${String(archiveIndex++).padStart(4, "0")}.a`,
					);
					copyFileSync(argument, destination, constants.COPYFILE_FICLONE);
					return destination;
				});
				const materializedLinkArguments = toolArguments(context.toolchain.tools.cc, [
					...compileArguments,
					...materializedObjects,
					...materializedArtifacts,
					...(zigLinkTimeStrip ? context.toolchain.probes.stripArgs : []),
				]);
				runNativeCommand(
					context,
					context.toolchain.tools.cc.path,
					[...materializedLinkArguments, "-o", binaryPath],
					{ verbose: options.verbose },
				);
			} finally {
				rmSync(linkDirectory, { recursive: true, force: true });
			}
			linkDurationMs = performance.now() - phaseStartedAt;
			context.onBuildPhase?.({
				phase: "link",
				durationMs: linkDurationMs,
				cache: "miss",
				path: binaryPath,
			});
			let cacheable = true;
			if (
				context.plan.strip &&
				context.toolchain.tools.strip !== undefined &&
				!zigLinkTimeStrip
			) {
				try {
					const stripStartedAt = performance.now();
					runNativeCommand(
						context,
						context.toolchain.tools.strip.path,
						toolArguments(context.toolchain.tools.strip, [
							...context.toolchain.probes.stripArgs,
							binaryPath,
						]),
						{ verbose: options.verbose },
					);
					context.onBuildPhase?.({
						phase: "strip",
						durationMs: performance.now() - stripStartedAt,
					});
				} catch (error) {
					cacheable = false;
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

	return {
		binaryPath,
		artifacts,
		context,
		measurements: {
			objects: generatedObjects.map((object) => object.measurement),
			cToObjectDurationMs,
			linkDurationMs,
			linkCache,
		},
	};
}
