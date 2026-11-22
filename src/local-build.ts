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
	artifactFileDigest,
	artifactIdentity,
	artifactOutput,
	artifactProducer,
	materializeArtifact,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "./artifact-store.ts";
import type { ArtifactAction } from "./artifact-store.ts";
import type { IncludedAsset } from "./assets.ts";
import {
	buildSuffix,
	ccExtraFlags,
	normalizeNativeFeatures,
	optFlags,
} from "./build-flags.ts";
import {
	compileArgumentsEmitDebugInfo,
	expandedGeneratedUnitDigest,
} from "./c-declaration-slice.ts";
import type { PreludeDeclarations } from "./c-declaration-slice.ts";
import { maligatorBuildDirectory, maligatorCacheDirectory } from "./cache-root.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { compilerProducerIdentity } from "./compiler-cache-identity.ts";
import { languageComponentAnchorSource } from "./compiler/frontend/engine-components.ts";
import type {
	GeneratedTranslationUnit,
	GeneratedTranslationUnitDefinition,
	GeneratedTranslationUnitKind,
} from "./compiler/target/emit-program-image.ts";
import { DEVELOPMENT_FRAGMENT_MAIN } from "./development-fragments.ts";
import { libraryLinkArguments } from "./ffi/discovery.ts";
import type { LinkInput } from "./ffi/discovery.ts";
import { writeSourceChunks } from "./generated-source.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
import { normalizeRuntimeBuildArgument } from "./native-cache-identity.ts";
import { runNativeCommand, runNativeCommands } from "./native-command.ts";
import type { NativeCommandMeasurement } from "./native-command.ts";
import {
	packagedRuntimeDirectory,
	PREBUILT_RUNTIME_MANIFEST,
	prebuiltDevelopmentRunnerKey,
	prebuiltDevelopmentRunnerTarget,
	readPrebuiltDevelopmentRunner,
} from "./prebuilt-runtime.ts";
import { ensureNativeArtifacts } from "./runtime-build.ts";
import type { NativeArtifacts } from "./runtime-build.ts";
import { generatedHeaderDependencyHash, runtimeHeaderHash } from "./runtime-build.ts";
import { toolArguments } from "./toolchain.ts";

const BUILD_DIRECTORY = maligatorBuildDirectory();
const RUNNER_WORK_ID = randomUUID();
const GENERATED_SOURCES_STAGE = "generated-sources";
const GENERATED_OBJECT_PRODUCER = artifactProducer("generated-object", 5, "cc");
const GENERATED_UNIT_SLICE_PRODUCER = artifactProducer(
	"generated-unit-slice",
	2,
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
	cSource:
		| string
		| ReadonlyArray<string | GeneratedTranslationUnit>
		| GeneratedSourceFiles;
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

export interface GeneratedSourceFiles {
	readonly units: ReadonlyArray<GeneratedObjectInput>;
	readonly sourceCodeUnits: number;
	readonly writeDurationMs: number;
	readonly cache?: "hit" | "miss";
}

type LocalBuildOutputOptions = Pick<
	LocalBuildOptions,
	"context" | "name" | "cacheSuffix" | "outDir"
>;

function localBuildOutput(options: LocalBuildOutputOptions) {
	const { context } = options;
	const artifactName = `${options.name}${buildSuffix(options.cacheSuffix ?? "", context.environment)}`;
	const directory =
		options.outDir ??
		path.join(
			BUILD_DIRECTORY,
			context.plan.mode,
			...(context.toolchain.cross === true ? [context.toolchain.rustTarget] : []),
		);
	return { directory, artifactName, binaryPath: path.join(directory, artifactName) };
}

function generatedSourcePath(
	directory: string,
	name: string,
	index: number,
	id: string,
): string {
	return path.join(directory, index === 0 ? `${name}.c` : `${name}.${id}.c`);
}

/** Materialize each unit before its producer prepares another root or runtime image. */
export function prepareGeneratedSources(
	options: LocalBuildOutputOptions,
	sources: Iterable<string | GeneratedTranslationUnit>,
): GeneratedSourceFiles {
	const { directory, artifactName } = localBuildOutput(options);
	mkdirSync(directory, { recursive: true });
	const units: Array<GeneratedObjectInput> = [];
	const ids = new Set<string>();
	let sourceCodeUnits = 0;
	let writeDurationMs = 0;
	for (const input of sources) {
		const startedAt = performance.now();
		const id =
			typeof input === "string"
				? `source-${artifactDigest(input).slice(0, 16)}`
				: input.id;
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(id))
			throw new Error(`generated translation unit has unsafe id '${id}'`);
		if (ids.has(id)) throw new Error(`duplicate generated translation unit id '${id}'`);
		ids.add(id);
		const sourcePath = generatedSourcePath(directory, artifactName, units.length, id);
		const digest = createHash("sha256");
		const sourceChunks = typeof input === "string" ? [input] : input.sourceChunks;
		const sourceBytes = writeSourceChunks(sourcePath, sourceChunks, digest);
		sourceCodeUnits += typeof input === "string" ? input.length : input.sourceCodeUnits;
		units.push({
			sourcePath,
			unitId: id,
			sourceDigest: digest.digest("hex"),
			sourceBytes,
			role: "generated",
			...(typeof input === "string"
				? {}
				: {
						generatedKind: input.kind,
						headerFiles: input.headerFiles,
						definitions: input.definitions,
						...(input.embeddedFileDigests === undefined
							? {}
							: { embeddedFileDigests: input.embeddedFileDigests }),
					}),
		});
		writeDurationMs += performance.now() - startedAt;
	}
	if (units.length === 0)
		throw new Error("buildLocalBinary requires at least one C translation unit");
	return { units, sourceCodeUnits, writeDurationMs };
}

type GeneratedSourceDescriptor = Pick<
	GeneratedObjectInput,
	"unitId" | "generatedKind" | "headerFiles" | "definitions" | "embeddedFileDigests"
>;

interface GeneratedSourceManifest {
	readonly units: ReadonlyArray<GeneratedSourceDescriptor>;
	readonly sourceCodeUnits: number;
	readonly warnings: ReadonlyArray<string>;
}

function readGeneratedSourceManifest(
	action: ArtifactAction,
): GeneratedSourceManifest | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(artifactOutput(action, "sources.json").path, "utf8"),
		) as GeneratedSourceManifest;
		if (
			!Number.isSafeInteger(manifest.sourceCodeUnits) ||
			manifest.sourceCodeUnits < 0 ||
			!Array.isArray(manifest.warnings) ||
			!manifest.warnings.every((message) => typeof message === "string") ||
			!Array.isArray(manifest.units) ||
			manifest.units.length === 0 ||
			manifest.units.length !== action.outputs.length - 1
		)
			return undefined;
		for (const [index, { unitId }] of manifest.units.entries()) {
			if (
				typeof unitId !== "string" ||
				!/^[a-z0-9][a-z0-9._-]*$/.test(unitId) ||
				action.outputs[index + 1]?.name !== `${unitId}.c`
			)
				return undefined;
		}
		return manifest;
	} catch {
		return undefined;
	}
}

export function prepareCachedGeneratedSources(
	options: LocalBuildOutputOptions,
	emission: { image: string; directory: string; assets: ReadonlyArray<IncludedAsset> },
	sources: (onWarning: (warning: string) => void) => Iterable<GeneratedTranslationUnit>,
	onWarning: (warning: string) => void,
): GeneratedSourceFiles {
	const { cacheDirectory } = options.context;
	const producer = compilerProducerIdentity(GENERATED_SOURCES_STAGE, 1);
	const key = artifactActionKey(producer, emission);
	const restore = (
		manifest: GeneratedSourceManifest,
		action: ArtifactAction,
		cache: "hit" | "miss",
	): GeneratedSourceFiles => {
		const startedAt = performance.now();
		const { directory, artifactName } = localBuildOutput(options);
		const units = manifest.units.map(
			(
				{ unitId, generatedKind, headerFiles, definitions, embeddedFileDigests },
				index,
			): GeneratedObjectInput => {
				const file = action.outputs[index + 1]!;
				const sourcePath = generatedSourcePath(directory, artifactName, index, unitId);
				materializeArtifact(file, sourcePath);
				return {
					unitId,
					generatedKind,
					headerFiles,
					definitions,
					embeddedFileDigests,
					sourcePath,
					sourceDigest: file.digest,
					sourceBytes: file.size,
					role: "generated",
				};
			},
		);
		for (const warning of manifest.warnings) onWarning(warning);
		return {
			units,
			sourceCodeUnits: manifest.sourceCodeUnits,
			writeDurationMs: performance.now() - startedAt,
			cache,
		};
	};
	const restoreCached = () => {
		const action = readArtifactAction(
			cacheDirectory,
			GENERATED_SOURCES_STAGE,
			producer,
			key,
		);
		if (action === undefined) return undefined;
		const manifest = readGeneratedSourceManifest(action);
		return manifest === undefined ? undefined : restore(manifest, action, "hit");
	};
	return (
		restoreCached() ??
		withArtifactActionLock(cacheDirectory, GENERATED_SOURCES_STAGE, producer, key, () => {
			const cached = restoreCached();
			if (cached !== undefined) return cached;
			const work = path.join(cacheDirectory, "work", GENERATED_SOURCES_STAGE);
			mkdirSync(work, { recursive: true });
			const outDir = mkdtempSync(path.join(work, "emit-"));
			try {
				// Shared output names can be replaced by another build while this action is published.
				const warnings: Array<string> = [];
				const generated = prepareGeneratedSources(
					{ ...options, outDir },
					sources((warning) => warnings.push(warning)),
				);
				const manifest: GeneratedSourceManifest = {
					units: generated.units.map(
						({
							unitId,
							generatedKind,
							headerFiles,
							definitions,
							embeddedFileDigests,
						}) => ({
							unitId,
							generatedKind,
							headerFiles,
							definitions,
							embeddedFileDigests,
						}),
					),
					sourceCodeUnits: generated.sourceCodeUnits,
					warnings,
				};
				const metadataPath = path.join(outDir, "sources.json");
				writeFileSync(metadataPath, JSON.stringify(manifest));
				const action = publishArtifactAction(
					cacheDirectory,
					GENERATED_SOURCES_STAGE,
					producer,
					key,
					[
						{ name: "sources.json", file: metadataPath },
						...generated.units.map(({ unitId, sourcePath }) => ({
							name: `${unitId}.c`,
							file: sourcePath,
						})),
					],
				);
				const output = restore(manifest, action, "miss");
				return {
					...output,
					writeDurationMs: generated.writeDurationMs + output.writeDurationMs,
				};
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		})
	);
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
	if (
		context.plan.thinLtoCache === null ||
		!optFlags(context.plan, context.environment).includes("-flto=thin")
	)
		return undefined;
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
			cc: context.toolchain.ccFingerprint,
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
			const file = expanded[position]!;
			// Declaration slicing is a cache precision optimization. Large expansions
			// use their complete bytes so parsing never requires an unbounded string.
			const digest =
				sliced && statSync(file).size <= 8 * 1024 * 1024
					? expandedGeneratedUnitDigest(readFileSync(file, "utf8"), preludes)
					: artifactFileDigest(file, "expanded\0");
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
			digests[index] = artifactFileDigest(expanded[position]!);
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
): { objects: Array<GeneratedObject>; projectionDurationMs: number } {
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
				? runtimeHeaderHash(context.runtimeDirectory, context.cacheDirectory)
				: generatedHeaderDependencyHash(context.runtimeDirectory, input.headerFiles);
		headerHashes.set(identity, digest);
		return digest;
	};
	let unitDigests: Array<string>;
	let projectionDurationMs = 0;
	const projectionStartedAt = performance.now();
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
		projectionDurationMs = performance.now() - projectionStartedAt;
		context.onBuildPhase?.({
			phase: "generated C projection",
			durationMs: projectionDurationMs,
			units: inputs.length,
		});
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
			cc: context.toolchain.ccFingerprint,
			target: context.toolchain.target,
		});
		const costKey = artifactActionKey(GENERATED_OBJECT_COST_PRODUCER, {
			unitId: input.unitId,
			compileArguments: normalizedArgumentsOf(input),
			headerDependencies,
			environment: context.environmentFingerprint,
			cc: context.toolchain.ccFingerprint,
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
	const objects = results.map((object, index) => {
		if (object === undefined) {
			throw new Error(`generated object result missing for ${inputs[index]?.sourcePath}`);
		}
		onObject?.(object.measurement);
		return object;
	});
	return { objects, projectionDurationMs };
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
		cSource: languageComponentAnchorSource(context.features),
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
	return buildLocalBinary(
		developmentRunnerOptions(context, verbose, cacheSuffix, libraries),
	);
}

function developmentRunnerOptions(
	context: NativeBuildContext,
	verbose: boolean,
	cacheSuffix?: string,
	libraries?: Pick<LocalBuildOptions, "externalUnits" | "linkInputs">,
): LocalBuildOptions & { cSource: string; mainFile: string } {
	return {
		context,
		name: "MaligatorDev",
		cSource: languageComponentAnchorSource(context.features),
		verbose,
		mainFile: path.join(context.runtimeDirectory, "dev_main.c"),
		cacheSuffix,
		outDir: runnerWorkDirectory(context),
		...libraries,
	};
}

function supportsDevelopmentShims(context: NativeBuildContext): boolean {
	const platform = context.toolchain.platform ?? process.platform;
	return platform === "darwin" || platform === "linux";
}

function sharedDevelopmentRunnerFeatures(
	features: NativeBuildContext["features"],
): NativeBuildContext["features"] {
	return normalizeNativeFeatures({
		...features,
		developmentApiEnabled: true,
		usesHost: true,
		usesUrlParser: true,
		temporalEnabled: true,
		intlEnabled: true,
		intlFeatures: [],
	});
}

export function localDevelopmentRunnerKey(
	context: NativeBuildContext,
	linkedLibraries?: string,
): string {
	return artifactIdentity({
		toolchain: context.toolchain.fingerprint,
		environment: context.environmentFingerprint,
		features:
			linkedLibraries === undefined
				? sharedDevelopmentRunnerFeatures(context.features)
				: context.features,
		libraries: linkedLibraries,
	});
}

export function sharedDevelopmentRunnerKey(
	inputs: Pick<
		NativeBuildContext,
		"runtimeDirectory" | "cacheDirectory" | "features" | "environment"
	>,
	target: string,
): string {
	const features = sharedDevelopmentRunnerFeatures(inputs.features);
	return prebuiltDevelopmentRunnerKey({
		...inputs,
		target,
		features,
		anchorSource: languageComponentAnchorSource(features),
	});
}

export function packagedDevelopmentRunner(
	runtimeDirectory: string,
	features: NativeBuildContext["features"],
	environment: NodeJS.ProcessEnv,
): string | undefined {
	if (!features.primordialsLocked || features.realmsEnabled || features.profileEnabled)
		return undefined;
	const target = prebuiltDevelopmentRunnerTarget(environment);
	const directory = packagedRuntimeDirectory(environment);
	if (
		target === undefined ||
		directory === undefined ||
		!existsSync(path.join(directory, PREBUILT_RUNTIME_MANIFEST))
	)
		return undefined;
	return readPrebuiltDevelopmentRunner(directory, target, {
		requiresEval: features.evalEnabled,
		keyForEvalComponent: (evalComponent) =>
			sharedDevelopmentRunnerKey(
				{
					runtimeDirectory,
					cacheDirectory: maligatorCacheDirectory(undefined, environment),
					features: { ...features, evalEnabled: evalComponent },
					environment,
				},
				target,
			),
	});
}

export function buildSharedDevelopmentRunner(
	context: NativeBuildContext,
	verbose: boolean,
): string {
	context = { ...context, features: sharedDevelopmentRunnerFeatures(context.features) };
	const platform = context.toolchain.platform ?? process.platform;
	const libraries = supportsDevelopmentShims(context)
		? {
				externalUnits: [
					{
						id: "ffi-shim-loader",
						source: {
							path: path.join(context.runtimeDirectory, "src/ffi/mal_ffi_shim_loader.c"),
						},
						compileArguments: ["-std=c2x"],
					},
				],
				linkInputs: platform === "linux" ? [{ kind: "system" as const, name: "dl" }] : [],
			}
		: undefined;
	const options = developmentRunnerOptions(context, verbose, undefined, libraries);
	const artifacts = ensureNativeArtifacts(context, verbose);
	const { artifactName } = localBuildOutput(options);
	const normalizeArgument = (argument: string) =>
		normalizeRuntimeBuildArgument(context.runtimeDirectory, argument);
	const keyForInputs = () =>
		artifactActionKey(LINKED_BINARY_PRODUCER, {
			sharedDevelopmentRunner: {
				objectProducer: GENERATED_OBJECT_PRODUCER,
				projectionProducer: GENERATED_UNIT_SLICE_PRODUCER,
				features: context.features,
				toolchain: context.toolchain.fingerprint,
				cc: context.toolchain.ccFingerprint,
				target: context.toolchain.target,
				environment: context.environmentFingerprint,
				compileArguments: generatedCCompileArguments(context).map(normalizeArgument),
				thinLtoCache: context.plan.thinLtoCache,
				strip: context.plan.strip ? context.toolchain.probes.stripArgs : undefined,
				anchor: options.cSource,
				driver: artifactFileDigest(options.mainFile),
				headers: runtimeHeaderHash(context.runtimeDirectory, context.cacheDirectory),
				// The native actions already verified these content-addressed archive paths.
				runtime: artifacts.linkArgs,
				shim: libraries?.externalUnits.map((unit) => ({
					id: unit.id,
					source: artifactFileDigest(unit.source.path),
					arguments: unit.compileArguments,
				})),
				libraries: libraries?.linkInputs,
			},
		});
	// User-supplied search paths can introduce headers or libraries outside the
	// runtime tree and the selected toolchain.
	const key = [
		"CPATH",
		"C_INCLUDE_PATH",
		"CPLUS_INCLUDE_PATH",
		"OBJC_INCLUDE_PATH",
		"SDKROOT",
		"LIBRARY_PATH",
		"COMPILER_PATH",
		"GCC_EXEC_PREFIX",
	].some((name) => context.environment[name])
		? undefined
		: keyForInputs();
	if (key !== undefined) {
		const startedAt = performance.now();
		const action = readArtifactAction(
			context.cacheDirectory,
			"linked-binary",
			LINKED_BINARY_PRODUCER,
			key,
		);
		if (action !== undefined) {
			const binary = artifactOutput(action, "binary");
			const executable = sharedRunnerExecutable(context, key, artifactName);
			if (!existsSync(executable)) materializeArtifact(binary, executable);
			context.onCacheEvent?.({ artifact: "binary", hit: true, path: binary.path });
			context.onBuildPhase?.({
				phase: "link",
				durationMs: performance.now() - startedAt,
				cache: "hit",
				path: binary.path,
			});
			return executable;
		}
	}
	const workRoot = path.join(context.cacheDirectory, "work");
	mkdirSync(workRoot, { recursive: true });
	const work = mkdtempSync(path.join(workRoot, "shared-runner-"));
	try {
		return linkLocalBinary({ ...options, outDir: work }, { artifacts, key, keyForInputs })
			.binaryPath;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function sharedRunnerExecutable(
	context: NativeBuildContext,
	key: string,
	artifactName: string,
): string {
	return path.join(context.cacheDirectory, "work", "local-runner", key, artifactName);
}

/**
 * A binary that resolves host installers by name, such as the development runner or a
 * development fragment program, references every installer, so it links the native
 * components of all host installers. The C runtime is the same for all of them.
 */
function resolvesInstallersByName(options: LocalBuildOptions): boolean {
	const main =
		options.mainFile === undefined ? undefined : path.basename(options.mainFile);
	return (
		main === "dev_main.c" ||
		main === DEVELOPMENT_FRAGMENT_MAIN ||
		options.context.features.developmentApiEnabled
	);
}

/** Link emitted generated C into a standalone binary using one resolved context. */
export function buildLocalBinary(options: LocalBuildOptions): LocalBuildResult {
	return linkLocalBinary(options);
}

function linkLocalBinary(
	options: LocalBuildOptions,
	sharedRunner?: {
		artifacts: NativeArtifacts;
		key: string | undefined;
		keyForInputs: () => string;
	},
): LocalBuildResult {
	const resolvesByName = resolvesInstallersByName(options);
	const context = resolvesByName
		? Object.freeze({
				...options.context,
				features: Object.freeze(
					normalizeNativeFeatures({
						...options.context.features,
						usesHost: true,
						usesUrlParser: true,
					}),
				),
			})
		: options.context;
	// Zig's strip capability is probed and applied through its cc driver because
	// objcopy can reject large LTO ELFs after succeeding on a small probe.
	const zigLinkTimeStrip =
		context.plan.strip && context.toolchain.tools.strip?.args?.[0] === "objcopy";
	const {
		directory: outputDirectory,
		artifactName,
		binaryPath,
	} = localBuildOutput(options);
	mkdirSync(outputDirectory, { recursive: true });
	const sources =
		typeof options.cSource === "object" && "units" in options.cSource
			? options.cSource
			: prepareGeneratedSources(
					options,
					typeof options.cSource === "string" ? [options.cSource] : options.cSource,
				);
	const unitIds = new Set<string>();
	for (const id of [
		...sources.units.map((unit) => unit.unitId),
		...(options.externalUnits ?? []).map((unit) => unit.id),
	]) {
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
			throw new Error(`generated translation unit has unsafe id '${id}'`);
		}
		if (unitIds.has(id)) {
			throw new Error(`duplicate generated translation unit id '${id}'`);
		}
		unitIds.add(id);
	}
	context.onBuildPhase?.({
		phase: "write generated C",
		durationMs: sources.writeDurationMs,
		units: sources.units.length,
		bytes: sources.units.reduce((total, source) => total + source.sourceBytes, 0),
	});
	const artifacts =
		sharedRunner?.artifacts ?? ensureNativeArtifacts(context, options.verbose);
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
	const compileArguments = generatedCCompileArguments(context);
	if (sharedRunner && supportsDevelopmentShims(context))
		compileArguments.push("-DMAL_FFI_SHIMS=1");
	const thinLtoCache = thinLtoCacheArguments(context);
	let phaseStartedAt = performance.now();
	const mainFile =
		options.mainFile ?? path.join(context.runtimeDirectory, "test262_main.c");
	const mainSource = readFileSync(mainFile);
	const languageComponents: Array<GeneratedObjectInput> = [];
	const componentLinkArgs: Array<string> = [];
	if (context.features.intlEnabled || context.features.temporalEnabled) {
		const main = path.basename(mainFile);
		const hasComponentAnchor = ["dev_main.c", "load_main.c", "test262_wire.c"].includes(
			main,
		);
		if (resolvesByName && !hasComponentAnchor) {
			// Wire manifests carry names without linker references.
			const unitId = "wire-language-components";
			const sourcePath = path.join(outputDirectory, `${artifactName}.${unitId}.c`);
			const source = languageComponentAnchorSource(context.features);
			writeFileSync(sourcePath, source);
			languageComponents.push({
				sourcePath,
				unitId,
				sourceDigest: artifactDigest(source),
				sourceBytes: Buffer.byteLength(source),
				role: "driver",
			});
		}
		if (resolvesByName || hasComponentAnchor) {
			const prefix =
				(context.toolchain.platform ?? process.platform) === "darwin" ? "_" : "";
			componentLinkArgs.push(`-Wl,-u,${prefix}mal_wire_language_components`);
		}
	}
	const runtimeLinkArgs = [...componentLinkArgs, ...artifacts.linkArgs];
	const { objects: generatedObjects, projectionDurationMs } = ensureGeneratedObjects(
		context,
		[
			...sources.units,
			...externalInputs,
			...languageComponents,
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
		durationMs: cToObjectDurationMs - projectionDurationMs,
		units: objects.length + 1,
		bytes: [...objects, mainObject].reduce(
			(total, object) => total + statSync(object.path).size,
			0,
		),
	});
	const linkKey =
		sharedRunner?.key ??
		artifactActionKey(LINKED_BINARY_PRODUCER, {
			cacheVariant: options.linkCacheVariant,
			compileArguments: compileArguments.map((argument) =>
				normalizeRuntimeBuildArgument(context.runtimeDirectory, argument),
			),
			objects: [...objects, mainObject].map((object) => object.digest),
			artifacts: runtimeLinkArgs.map((argument) =>
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
						? {
								...input,
								digest: artifactDigest(new Uint8Array(readFileSync(input.path))),
							}
						: input,
			),
			zigStripArgs: zigLinkTimeStrip ? context.toolchain.probes.stripArgs : [],
			thinLtoCache: thinLtoCache === undefined ? null : context.plan.thinLtoCache,
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
	const executable = sharedRunner
		? sharedRunnerExecutable(context, linkKey, artifactName)
		: binaryPath;
	const restoreBinary = (binary: ReturnType<typeof artifactOutput>): void => {
		if (!sharedRunner || !existsSync(executable)) materializeArtifact(binary, executable);
	};
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
		restoreBinary(binary);
		const linkDurationMs = performance.now() - phaseStartedAt;
		context.onBuildPhase?.({
			phase: "link",
			durationMs: linkDurationMs,
			cache: "hit",
			path: binary.path,
		});
		return {
			binaryPath: executable,
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
				restoreBinary(artifactOutput(raced, "binary"));
				linkCache = "hit";
				linkDurationMs = performance.now() - phaseStartedAt;
				context.onBuildPhase?.({
					phase: "link",
					durationMs: linkDurationMs,
					cache: "hit",
					path: executable,
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
				const libraryArguments = (options.linkInputs ?? []).flatMap((input) =>
					input.kind === "archive"
						? [materializeArchive(input.path)]
						: libraryLinkArguments(input),
				);
				const materializedArtifacts = runtimeLinkArgs.map((argument) =>
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
				if (
					sharedRunner?.key !== undefined &&
					sharedRunner.keyForInputs() !== sharedRunner.key
				) {
					throw new Error("Development runner inputs changed during the build");
				}
				const publishStartedAt = performance.now();
				const published = publishArtifactAction(
					context.cacheDirectory,
					"linked-binary",
					LINKED_BINARY_PRODUCER,
					linkKey,
					[{ name: "binary", file: binaryPath }],
				);
				const binary = artifactOutput(published, "binary");
				if (sharedRunner) restoreBinary(binary);
				context.onBuildPhase?.({
					phase: "publish binary",
					durationMs: performance.now() - publishStartedAt,
					path: binary.path,
				});
			}
		},
	);

	return {
		binaryPath: executable,
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
