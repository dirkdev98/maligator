import { hash } from "node:crypto";
import {
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
import { runNativeCommand } from "./native-command.ts";
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

function ensureGeneratedObject(
	context: NativeBuildContext,
	runtimeArtifactPath: string,
	sourcePath: string,
	source: string,
	compileArguments: Array<string>,
	verbose: boolean,
	onCacheEvent?: (event: { hit: boolean; path: string }) => void,
): string {
	const key = hash(
		"sha256",
		JSON.stringify({
			schema: 1,
			sourcePath,
			source: hash("sha256", source, "hex"),
			compileArguments,
			runtimeArtifactDirectory: path.dirname(runtimeArtifactPath),
			environment: context.environmentFingerprint,
			toolchain: context.toolchain.fingerprint,
			target: context.toolchain.target,
		}),
		"hex",
	).slice(0, 32);
	const parent = path.join(context.cacheDirectory, "generated-c");
	const directory = path.join(parent, key);
	const objectPath = path.join(directory, "unit.o");
	if (validGeneratedObject(directory, key)) {
		onCacheEvent?.({ hit: true, path: objectPath });
		return objectPath;
	}

	mkdirSync(parent, { recursive: true });
	rmSync(directory, { recursive: true, force: true });
	const temporaryDirectory = mkdtempSync(path.join(parent, ".build-"));
	const temporaryObject = path.join(temporaryDirectory, "unit.o");
	try {
		runNativeCommand(
			context,
			context.toolchain.tools.cc.path,
			toolArguments(context.toolchain.tools.cc, [
				...compileArguments,
				"-c",
				sourcePath,
				"-o",
				temporaryObject,
			]),
			{ verbose },
		);
		const bytes = readFileSync(temporaryObject);
		if (bytes.length === 0)
			throw new Error(`compiler produced an empty object: ${sourcePath}`);
		writeFileSync(
			path.join(temporaryDirectory, "artifact.json"),
			`${JSON.stringify({
				schema: 1,
				key,
				size: bytes.length,
				digest: hash("sha256", bytes, "hex"),
			} satisfies GeneratedObjectManifest)}\n`,
		);
		try {
			renameSync(temporaryDirectory, directory);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				(code !== "EEXIST" && code !== "ENOTEMPTY") ||
				!validGeneratedObject(directory, key)
			) {
				throw error;
			}
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
	if (!validGeneratedObject(directory, key)) {
		throw new Error(`generated object cache publication failed: ${objectPath}`);
	}
	onCacheEvent?.({ hit: false, path: objectPath });
	return objectPath;
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
	const objectPaths = cPaths.map((sourcePath, index) =>
		ensureGeneratedObject(
			context,
			artifacts.c.runtime,
			sourcePath,
			sources[index]!,
			compileArguments,
			options.verbose,
			options.onGeneratedObjectCacheEvent,
		),
	);
	const mainFile =
		options.mainFile ?? path.join(context.runtimeDirectory, "test262_main.c");
	const mainObject = ensureGeneratedObject(
		context,
		artifacts.c.runtime,
		mainFile,
		readFileSync(mainFile, "utf-8"),
		compileArguments,
		options.verbose,
		options.onGeneratedObjectCacheEvent,
	);
	context.onBuildPhase?.({
		phase: "generated C objects",
		durationMs: performance.now() - phaseStartedAt,
	});

	phaseStartedAt = performance.now();
	runNativeCommand(
		context,
		context.toolchain.tools.cc.path,
		toolArguments(context.toolchain.tools.cc, [
			...compileArguments,
			...objectPaths,
			mainObject,
			...artifacts.linkArgs,
			...(zigLinkTimeStrip ? context.toolchain.probes.stripArgs : []),
			"-o",
			binaryPath,
		]),
		{ verbose: options.verbose },
	);
	context.onBuildPhase?.({
		phase: "link",
		durationMs: performance.now() - phaseStartedAt,
	});
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
			if (objcopy !== undefined) rmSync(objcopy, { force: true });
			options.onWarning?.(
				`production symbol stripping failed after a successful probe; leaving the binary unstripped: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return { binaryPath, artifacts, context };
}
