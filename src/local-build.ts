import { createHash, randomUUID } from "node:crypto";
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
	artifactIdentity,
	artifactOutput,
	artifactProducer,
	materializeArtifact,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "./artifact-store.ts";
import { buildSuffix, ccExtraFlags } from "./build-flags.ts";
import {
	compileArgumentsEmitDebugInfo,
	expandedGeneratedUnitDigest,
} from "./c-declaration-slice.ts";
import type { PreludeDeclarations } from "./c-declaration-slice.ts";
import { maligatorBuildDirectory } from "./cache-root.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import type {
	GeneratedTranslationUnit,
	GeneratedTranslationUnitDefinition,
	GeneratedTranslationUnitKind,
} from "./compiler/target/emit-program-image.ts";
import type { LinkInput } from "./ffi/discovery.ts";
import { writeSourceChunks } from "./generated-source.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { normalizeRuntimeBuildArgument } from "./native-cache-identity.ts";
import { runNativeCommand, runNativeCommands } from "./native-command.ts";
import type { NativeCommandMeasurement } from "./native-command.ts";
import { ensureNativeArtifacts } from "./runtime-build.ts";
import type { NativeArtifacts } from "./runtime-build.ts";
import { generatedHeaderDependencyHash, runtimeHeaderHash } from "./runtime-build.ts";
import { toolArguments } from "./toolchain.ts";

const BUILD_DIRECTORY = maligatorBuildDirectory();
const RUNNER_WORK_ID = randomUUID();
const GENERATED_OBJECT_PRODUCER = artifactProducer("generated-object", 5, "cc");
const GENERATED_UNIT_SLICE_PRODUCER = artifactProducer(
	"generated-unit-slice",
	1,
	"cc-preprocess",
);
const GENERATED_OBJECT_COST_PRODUCER = artifactProducer(
	"generated-object-cost",
	1,
	"cc-time",
);
const LINKED_BINARY_PRODUCER = artifactProducer("linked-binary", 1, "cc-link");

function runnerWorkDirectory(context: NativeBuildContext): string {
	return path.join(
		context.cacheDirectory,
		"work",
		"local-runner",
		`${process.pid}-${RUNNER_WORK_ID}`,
		...(context.toolchain.cross === true ? [context.toolchain.rustTarget] : []),
	);
}

export type { BuildCacheEvent } from "./native-build-context.ts";

export interface GeneratedObjectMeasurement {
	unit: string;
	role: "generated" | "driver" | "library";
	generatedKind?: GeneratedTranslationUnitKind;
	definitions?: ReadonlyArray<GeneratedTranslationUnitDefinition>;
	cache: "hit" | "miss";
	sourceBytes: number;
	objectBytes: number;
	compileDurationMs: number | null;
	userCpuMs: number | null;
	systemCpuMs: number | null;
	peakRssBytes?: number;
	scheduledCompileDurationMs?: number;
	path: string;
}

export interface LocalBuildMeasurements {
	objects: ReadonlyArray<GeneratedObjectMeasurement>;
	slowestGeneratedUnits: ReadonlyArray<GeneratedObjectMeasurement>;
	cToObjectDurationMs: number;
	linkDurationMs: number;
	linkCache: "hit" | "miss";
}

/**
 * A translation unit compiled with its own arguments after the target's code
 * generation flags, such as a C library binding or one of the library's sources.
 */
export interface ExternalTranslationUnit {
	/** Unique among a build's units: lowercase letters, digits, `.`, `_`, and `-`. */
	id: string;
	/** Source text to write, or an existing file compiled in place. */
	source: { text: string } | { path: string };
	compileArguments: ReadonlyArray<string>;
}

export interface LocalBuildOptions {
	/** The fully resolved native inputs shared by archive construction and this link. */
	context: NativeBuildContext;
	/** Base name for the emitted `.c` and linked binary. */
	name: string;
	/** Emitted translation unit(s), each of which must already include `vm.h`. */
	cSource: string | ReadonlyArray<string | GeneratedTranslationUnit>;
	/** Surface compiler/archive output instead of swallowing it. */
	verbose: boolean;
	/** Entry-point translation unit; defaults to the test262 harness main. */
	mainFile?: string;
	/** Directory for the emitted `.c` and linked binary. */
	outDir?: string;
	/** Human-facing binary filename decoration only; never part of archive identity. */
	cacheSuffix?: string;
	/** Optional measurement namespace for generated-object cache keys. */
	objectCacheVariant?: string;
	/** Optional measurement namespace for the final-link cache key. */
	linkCacheVariant?: string;
	/** Units compiled with their own arguments, such as C library bindings and sources. */
	externalUnits?: ReadonlyArray<ExternalTranslationUnit>;
	/** Linked after the program's objects and before the runtime archives. */
	linkInputs?: ReadonlyArray<LinkInput>;
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

/** Exact compiler flags shared by generated application translation units. */
export function generatedCCompileArguments(context: NativeBuildContext): Array<string> {
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

function thinLtoCacheArguments(
	context: NativeBuildContext,
): { directory: string; arguments: Array<string> } | undefined {
	if (!context.plan.lto || context.plan.thinLtoCache === null) return undefined;
	const directory = path.join(
		context.cacheDirectory,
		"thinlto",
		artifactDigest(
			`${context.toolchain.fingerprint}\0${context.toolchain.target}\0${context.environmentFingerprint}`,
		).slice(0, 24),
	);
	return {
		directory,
		arguments: [
			context.plan.thinLtoCache === "darwin"
				? `-Wl,-cache_path_lto,${directory}`
				: context.plan.thinLtoCache === "plugin"
					? `-Wl,-plugin-opt,cache-dir=${directory}`
					: `-Wl,--thinlto-cache-dir=${directory}`,
		],
	};
}

interface GeneratedObjectInput {
	sourcePath: string;
	unitId: string;
	sourceDigest: string;
	sourceBytes: number;
	role: GeneratedObjectMeasurement["role"];
	generatedKind?: GeneratedTranslationUnitKind;
	headerFiles?: ReadonlyArray<string>;
	definitions?: ReadonlyArray<GeneratedTranslationUnitDefinition>;
	embeddedFileDigests?: ReadonlyArray<string>;
	/**
	 * Arguments replacing the shared generated-unit arguments. Such a unit reads
	 * headers outside the runtime, so its identity always comes from preprocessing it.
	 */
	compileArguments?: ReadonlyArray<string>;
}

function logicalSourcePath(input: GeneratedObjectInput): string {
	return input.role === "generated" ? `<generated>/${input.unitId}.c` : input.unitId;
}

/**
 * What each unit's object can depend on: its expanded body plus the prelude
 * declarations that body reaches, so header edits elsewhere keep its object. Digests
 * are memoized under the raw source and header contents; only units whose text or
 * headers changed are preprocessed again. A unit that embeds files is its text plus
 * their contents and is never expanded: the expansion spells each byte out as text,
 * which outgrows the engine's string limit for a few megabytes of data.
 */
function generatedUnitDigests(
	context: NativeBuildContext,
	inputs: ReadonlyArray<GeneratedObjectInput>,
	compileArguments: ReadonlyArray<string>,
	normalizedCompileArguments: ReadonlyArray<string>,
	headerHash: (input: GeneratedObjectInput) => string,
	directory: string,
	verbose: boolean,
): Array<string> {
	const digests = new Array<string | undefined>(inputs.length);
	const memoKeys = new Array<string | undefined>(inputs.length);
	const pending: Array<number> = [];
	const external: Array<number> = [];
	for (const [index, input] of inputs.entries()) {
		if (input.compileArguments !== undefined) {
			external.push(index);
			continue;
		}
		if (input.embeddedFileDigests !== undefined) {
			if (input.headerFiles?.length !== 0)
				throw new Error(
					`generated unit ${input.unitId} embeds files and includes headers`,
				);
			digests[index] = artifactIdentity({
				source: input.sourceDigest,
				embeddedFiles: input.embeddedFileDigests,
			});
			continue;
		}
		const key = artifactActionKey(GENERATED_UNIT_SLICE_PRODUCER, {
			logicalSourcePath: logicalSourcePath(input),
			source: input.sourceDigest,
			compileArguments: normalizedCompileArguments,
			headerDependencies: headerHash(input),
			environment: context.environmentFingerprint,
			toolchain: context.toolchain.fingerprint,
			target: context.toolchain.target,
		});
		memoKeys[index] = key;
		const cached = readArtifactAction(
			context.cacheDirectory,
			"generated-unit-slice",
			GENERATED_UNIT_SLICE_PRODUCER,
			key,
		);
		const digest =
			cached === undefined
				? undefined
				: readFileSync(artifactOutput(cached, "digest").path, "utf8");
		if (digest !== undefined && /^[0-9a-f]{64}$/.test(digest)) digests[index] = digest;
		else pending.push(index);
	}
	if (pending.length > 0) {
		const expanded = pending.map((index) => path.join(directory, `${String(index)}.i`));
		runNativeCommands(
			context,
			pending.map((index, position) => ({
				tool: context.toolchain.tools.cc.path,
				args: toolArguments(context.toolchain.tools.cc, [
					...compileArguments,
					`-ffile-prefix-map=${inputs[index]!.sourcePath}=${logicalSourcePath(inputs[index]!)}`,
					"-E",
					"-P",
					inputs[index]!.sourcePath,
					"-o",
					expanded[position]!,
				]),
			})),
			{ verbose },
		);
		const sliced = !compileArgumentsEmitDebugInfo(compileArguments);
		const preludes = new Map<string, PreludeDeclarations>();
		for (const [position, index] of pending.entries()) {
			const text = readFileSync(expanded[position]!, "utf8");
			const digest = sliced
				? expandedGeneratedUnitDigest(text, preludes)
				: artifactDigest(`expanded\0${text}`);
			digests[index] = digest;
			const digestPath = `${expanded[position]!}.digest`;
			writeFileSync(digestPath, digest);
			publishArtifactAction(
				context.cacheDirectory,
				"generated-unit-slice",
				GENERATED_UNIT_SLICE_PRODUCER,
				memoKeys[index]!,
				[{ name: "digest", file: digestPath }],
			);
		}
	}
	if (external.length > 0) {
		const expanded = external.map((index) => path.join(directory, `${String(index)}.i`));
		runNativeCommands(
			context,
			external.map((index, position) => ({
				tool: context.toolchain.tools.cc.path,
				args: toolArguments(context.toolchain.tools.cc, [
					...inputs[index]!.compileArguments!,
					"-E",
					"-P",
					inputs[index]!.sourcePath,
					"-o",
					expanded[position]!,
				]),
			})),
			{ verbose },
		);
		for (const [position, index] of external.entries()) {
			digests[index] = artifactDigest(new Uint8Array(readFileSync(expanded[position]!)));
		}
	}
	return digests.map((digest) => digest!);
}

interface PendingGeneratedObject {
	index: number;
	key: string;
	costKey: string;
	temporaryObject: string;
	compileArguments: ReadonlyArray<string>;
	sourcePath: string;
	logicalSourcePath: string;
	sourceBytes: number;
	scheduleCost: number;
	scheduledCompileDurationMs?: number;
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
	cacheVariant: string | undefined,
	onObject?: (event: GeneratedObjectMeasurement) => void,
): Array<GeneratedObject> {
	const parent = path.join(context.cacheDirectory, "work", "generated-object");
	mkdirSync(parent, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(parent, "build-"));
	const results = new Array<GeneratedObject | undefined>(inputs.length);
	const pending: Array<PendingGeneratedObject> = [];
	const normalizedCompileArguments = compileArguments.map((argument) =>
		normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
	);
	const argumentsOf = (input: GeneratedObjectInput): ReadonlyArray<string> =>
		input.compileArguments ?? compileArguments;
	const normalizedArgumentsOf = (input: GeneratedObjectInput): ReadonlyArray<string> =>
		input.compileArguments === undefined
			? normalizedCompileArguments
			: input.compileArguments.map((argument) =>
					normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
				);
	const headerHashes = new Map<string, string>();
	const headerHash = (input: GeneratedObjectInput): string => {
		const identity = input.headerFiles?.join("\0") ?? "<all-runtime-headers>";
		const cached = headerHashes.get(identity);
		if (cached !== undefined) return cached;
		const digest =
			input.headerFiles === undefined
				? runtimeHeaderHash(
						context.runtimeDirectory,
						context.features.nodeEnabled,
						context.cacheDirectory,
					)
				: generatedHeaderDependencyHash(context.runtimeDirectory, input.headerFiles);
		headerHashes.set(identity, digest);
		return digest;
	};
	let unitDigests: Array<string>;
	try {
		unitDigests = generatedUnitDigests(
			context,
			inputs,
			compileArguments,
			normalizedCompileArguments,
			headerHash,
			temporaryDirectory,
			verbose,
		);
	} catch (error) {
		rmSync(temporaryDirectory, { recursive: true, force: true });
		throw error;
	}
	for (const [index, input] of inputs.entries()) {
		const headerDependencies = headerHash(input);
		const key = artifactActionKey(GENERATED_OBJECT_PRODUCER, {
			cacheVariant,
			unitId: input.unitId,
			unit: unitDigests[index],
			compileArguments: normalizedArgumentsOf(input),
			environment: context.environmentFingerprint,
			toolchain: context.toolchain.fingerprint,
			target: context.toolchain.target,
		});
		const costKey = artifactActionKey(GENERATED_OBJECT_COST_PRODUCER, {
			unitId: input.unitId,
			compileArguments: normalizedArgumentsOf(input),
			headerDependencies,
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
					unit: input.unitId,
					role: input.role,
					...(input.generatedKind === undefined
						? {}
						: { generatedKind: input.generatedKind }),
					...(input.definitions === undefined ? {} : { definitions: input.definitions }),
					cache: "hit",
					sourceBytes: input.sourceBytes,
					objectBytes: statSync(output.path).size,
					compileDurationMs: null,
					userCpuMs: null,
					systemCpuMs: null,
					path: output.path,
				},
			};
			continue;
		}
		const sourceBytes = input.sourceBytes;
		let scheduledCompileDurationMs: number | undefined;
		const cachedCost = readArtifactAction(
			context.cacheDirectory,
			"generated-object-cost",
			GENERATED_OBJECT_COST_PRODUCER,
			costKey,
		);
		if (cachedCost !== undefined) {
			try {
				const sample = JSON.parse(
					readFileSync(artifactOutput(cachedCost, "measurement.json").path, "utf8"),
				) as { durationMs?: number; sourceBytes?: number };
				if (
					typeof sample.durationMs === "number" &&
					sample.durationMs >= 0 &&
					typeof sample.sourceBytes === "number" &&
					sample.sourceBytes > 0
				) {
					scheduledCompileDurationMs =
						sample.durationMs * (sourceBytes / sample.sourceBytes);
				}
			} catch {
				// A corrupt estimate cannot affect object correctness; source size remains safe.
			}
		}
		pending.push({
			index,
			key,
			costKey,
			temporaryObject: path.join(temporaryDirectory, `${String(index)}.o`),
			compileArguments: argumentsOf(input),
			sourcePath: input.sourcePath,
			logicalSourcePath: logicalSourcePath(input),
			sourceBytes,
			scheduleCost: scheduledCompileDurationMs ?? sourceBytes,
			...(scheduledCompileDurationMs === undefined ? {} : { scheduledCompileDurationMs }),
		});
	}

	try {
		const orderedPending = [...pending].sort(
			(left, right) =>
				right.scheduleCost - left.scheduleCost || right.sourceBytes - left.sourceBytes,
		);
		const measurements = runNativeCommands(
			context,
			orderedPending.map((entry) => ({
				tool: context.toolchain.tools.cc.path,
				args: toolArguments(context.toolchain.tools.cc, [
					...entry.compileArguments,
					`-ffile-prefix-map=${entry.sourcePath}=${entry.logicalSourcePath}`,
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
			const costPath = `${entry.temporaryObject}.measurement.json`;
			writeFileSync(
				costPath,
				`${JSON.stringify({
					durationMs: measurement.durationMs,
					sourceBytes: entry.sourceBytes,
				})}\n`,
			);
			withArtifactActionLock(
				context.cacheDirectory,
				"generated-object-cost",
				GENERATED_OBJECT_COST_PRODUCER,
				entry.costKey,
				() =>
					publishArtifactAction(
						context.cacheDirectory,
						"generated-object-cost",
						GENERATED_OBJECT_COST_PRODUCER,
						entry.costKey,
						[{ name: "measurement.json", file: costPath }],
					),
			);
			results[entry.index] = {
				path: output.path,
				digest: output.digest,
				measurement: {
					unit: input.unitId,
					role: input.role,
					...(input.generatedKind === undefined
						? {}
						: { generatedKind: input.generatedKind }),
					...(input.definitions === undefined ? {} : { definitions: input.definitions }),
					...(entry.scheduledCompileDurationMs === undefined
						? {}
						: {
								scheduledCompileDurationMs: entry.scheduledCompileDurationMs,
							}),
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
	libraries?: Pick<LocalBuildOptions, "externalUnits" | "linkInputs">,
): LocalBuildResult {
	return buildLocalBinary({
		context,
		name: "MaligatorDev",
		cSource: '#include "vm.h"\n',
		verbose,
		mainFile: path.join(context.runtimeDirectory, "dev_main.c"),
		cacheSuffix,
		outDir: runnerWorkDirectory(context),
		...libraries,
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
	const sourceInputs =
		typeof options.cSource === "string" ? [options.cSource] : [...options.cSource];
	if (sourceInputs.length === 0) {
		throw new Error("buildLocalBinary requires at least one C translation unit");
	}
	const units: Array<{
		id: string;
		sourceChunks: ReadonlyArray<string>;
		generatedKind?: GeneratedTranslationUnitKind;
		headerFiles?: ReadonlyArray<string>;
		definitions?: ReadonlyArray<GeneratedTranslationUnitDefinition>;
		embeddedFileDigests?: ReadonlyArray<string>;
	}> = sourceInputs.map((input) =>
		typeof input === "string"
			? {
					id: `source-${artifactDigest(input).slice(0, 16)}`,
					sourceChunks: [input],
				}
			: {
					id: input.id,
					sourceChunks: input.sourceChunks,
					generatedKind: input.kind,
					headerFiles: input.headerFiles,
					definitions: input.definitions,
					...(input.embeddedFileDigests === undefined
						? {}
						: { embeddedFileDigests: input.embeddedFileDigests }),
				},
	);
	const unitIds = new Set<string>();
	for (const unit of [...units, ...(options.externalUnits ?? [])]) {
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(unit.id)) {
			throw new Error(`generated translation unit has unsafe id '${unit.id}'`);
		}
		if (unitIds.has(unit.id)) {
			throw new Error(`duplicate generated translation unit id '${unit.id}'`);
		}
		unitIds.add(unit.id);
	}
	let phaseStartedAt = performance.now();
	const sourceMeasurements: Array<{ digest: string; bytes: number }> = [];
	const cPaths = units.map((unit, index) => {
		const sourcePath =
			index === 0 ? cPath : path.join(outputDirectory, `${artifactName}.${unit.id}.c`);
		const digest = createHash("sha256");
		const bytes = writeSourceChunks(sourcePath, unit.sourceChunks, digest);
		sourceMeasurements.push({ digest: digest.digest("hex"), bytes });
		return sourcePath;
	});
	const externalArguments = ccExtraFlags(
		context.plan,
		context.environment,
		context.toolchain.platform ?? process.platform,
	);
	const externalInputs = (options.externalUnits ?? []).map(
		(unit): GeneratedObjectInput => {
			let sourcePath: string;
			let source: Buffer;
			if ("text" in unit.source) {
				sourcePath = path.join(outputDirectory, `${artifactName}.${unit.id}.c`);
				writeFileSync(sourcePath, unit.source.text);
				source = Buffer.from(unit.source.text);
			} else {
				sourcePath = unit.source.path;
				source = readFileSync(sourcePath);
			}
			return {
				sourcePath,
				unitId: unit.id,
				sourceDigest: artifactDigest(new Uint8Array(source)),
				sourceBytes: source.length,
				role: "library",
				compileArguments: [...externalArguments, ...unit.compileArguments],
			};
		},
	);
	context.onBuildPhase?.({
		phase: "write generated C",
		durationMs: performance.now() - phaseStartedAt,
		units: units.length,
		bytes: sourceMeasurements.reduce((total, source) => total + source.bytes, 0),
	});
	const compileArguments = generatedCCompileArguments(context);
	const thinLtoCache = thinLtoCacheArguments(context);
	phaseStartedAt = performance.now();
	const mainFile =
		options.mainFile ?? path.join(context.runtimeDirectory, "test262_main.c");
	const mainSource = readFileSync(mainFile);
	const generatedObjects = ensureGeneratedObjects(
		context,
		[
			...cPaths.map((sourcePath, index) => ({
				sourcePath,
				unitId: units[index]!.id,
				sourceDigest: sourceMeasurements[index]!.digest,
				sourceBytes: sourceMeasurements[index]!.bytes,
				role: "generated" as const,
				...(units[index]!.generatedKind === undefined
					? {}
					: { generatedKind: units[index]!.generatedKind }),
				...(units[index]!.headerFiles === undefined
					? {}
					: { headerFiles: units[index]!.headerFiles }),
				...(units[index]!.definitions === undefined
					? {}
					: { definitions: units[index]!.definitions }),
				...(units[index]!.embeddedFileDigests === undefined
					? {}
					: { embeddedFileDigests: units[index]!.embeddedFileDigests }),
			})),
			...externalInputs,
			{
				sourcePath: mainFile,
				unitId: normalizeRuntimeBuildArgument(context.runtimeDirectory, mainFile),
				sourceDigest: artifactDigest(mainSource),
				sourceBytes: mainSource.length,
				role: "driver" as const,
			},
		],
		compileArguments,
		options.verbose,
		options.objectCacheVariant,
		options.onGeneratedObject,
	);
	const mainObject = generatedObjects.at(-1)!;
	const objects = generatedObjects.slice(0, -1);
	const slowestGeneratedUnits = objects
		.map((object) => object.measurement)
		.filter(
			(
				measurement,
			): measurement is GeneratedObjectMeasurement & {
				compileDurationMs: number;
			} => measurement.compileDurationMs !== null,
		)
		.sort((left, right) => right.compileDurationMs - left.compileDurationMs)
		.slice(0, 5);
	for (const measurement of slowestGeneratedUnits) {
		const largestDefinition = [...(measurement.definitions ?? [])].sort(
			(left, right) => right.sourceCodeUnits - left.sourceCodeUnits,
		)[0];
		if (
			measurement.compileDurationMs >= 5_000 ||
			(largestDefinition?.sourceCodeUnits ?? 0) >= 1024 * 1024
		) {
			const definitionDetails =
				largestDefinition === undefined
					? ""
					: `; largest definition ${largestDefinition.symbol} has ${largestDefinition.sourceCodeUnits} code units`;
			options.onWarning?.(
				`pathological generated C unit ${measurement.unit}: ${measurement.compileDurationMs.toFixed(1)} ms${definitionDetails}`,
			);
		}
	}
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
		cacheVariant: options.linkCacheVariant,
		compileArguments: compileArguments.map((argument) =>
			normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
		),
		objects: [...objects, mainObject].map((object) => object.digest),
		artifacts: artifacts.linkArgs.map((argument) =>
			argument.startsWith("-")
				? argument
				: artifactDigest(new Uint8Array(readFileSync(argument))),
		),
		linkInputs: (options.linkInputs ?? []).map((input) =>
			input.kind === "archive"
				? {
						kind: input.kind,
						digest: artifactDigest(new Uint8Array(readFileSync(input.path))),
					}
				: input.kind === "shared"
					? { ...input, digest: artifactDigest(new Uint8Array(readFileSync(input.path))) }
					: input,
		),
		zigStripArgs: zigLinkTimeStrip ? context.toolchain.probes.stripArgs : [],
		thinLtoCache: context.plan.thinLtoCache,
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
				slowestGeneratedUnits,
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
				if (thinLtoCache !== undefined) {
					mkdirSync(thinLtoCache.directory, { recursive: true });
				}
				const materializedObjects = [...objects, mainObject].map((object, index) => {
					const destination = path.join(
						linkDirectory,
						`${String(index).padStart(4, "0")}.o`,
					);
					copyFileSync(object.path, destination, constants.COPYFILE_FICLONE);
					return destination;
				});
				let archiveIndex = 0;
				const materializeArchive = (archive: string): string => {
					const destination = path.join(
						linkDirectory,
						`${String(archiveIndex++).padStart(4, "0")}.a`,
					);
					copyFileSync(archive, destination, constants.COPYFILE_FICLONE);
					return destination;
				};
				const libraryArguments = (options.linkInputs ?? []).flatMap((input) => {
					switch (input.kind) {
						case "archive":
							return [materializeArchive(input.path)];
						case "shared":
							// The binary loads it from where it was found, so keep that path.
							return [input.path, `-Wl,-rpath,${input.directory}`];
						case "system":
							return [`-l${input.name}`];
						case "framework":
							return ["-framework", input.name];
						case "flag":
							return [input.value];
					}
				});
				const materializedArtifacts = artifacts.linkArgs.map((argument) =>
					argument.startsWith("-") ? argument : materializeArchive(argument),
				);
				const materializedLinkArguments = toolArguments(context.toolchain.tools.cc, [
					...compileArguments,
					...materializedObjects,
					...libraryArguments,
					...materializedArtifacts,
					...(thinLtoCache?.arguments ?? []),
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
			slowestGeneratedUnits,
			cToObjectDurationMs,
			linkDurationMs,
			linkCache,
		},
	};
}
