import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildSuffix, ccExtraFlags } from "./build-flags.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import type { NativeBuildContext } from "./native-build-context.ts";
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
	/** Emitted translation unit (must already include `vm.h`). */
	cSource: string;
	/** Surface compiler/archive output instead of swallowing it. */
	verbose: boolean;
	/** Entry-point translation unit; defaults to the test262 harness main. */
	mainFile?: string;
	/** Directory for the emitted `.c` and linked binary. */
	outDir?: string;
	/** Human-facing binary filename decoration only; never part of archive identity. */
	cacheSuffix?: string;
	onWarning?: (message: string) => void;
}

/** Exact inputs and output of one final native link. */
export interface LocalBuildResult {
	binaryPath: string;
	artifacts: NativeArtifacts;
	context: NativeBuildContext;
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

	execFileSync(
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
		{ env: context.environment, stdio: verbose ? "inherit" : "pipe" },
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
	writeFileSync(cPath, options.cSource);

	execFileSync(
		context.toolchain.tools.cc.path,
		toolArguments(context.toolchain.tools.cc, [
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
			cPath,
			options.mainFile ?? path.join(context.runtimeDirectory, "test262_main.c"),
			...artifacts.linkArgs,
			...(zigLinkTimeStrip ? context.toolchain.probes.stripArgs : []),
			"-o",
			binaryPath,
		]),
		{ env: context.environment, stdio: options.verbose ? "inherit" : "pipe" },
	);
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
			execFileSync(
				context.toolchain.tools.strip.path,
				toolArguments(context.toolchain.tools.strip, [
					...context.toolchain.probes.stripArgs,
					binaryPath,
					...(objcopy === undefined ? [] : [objcopy]),
				]),
				{ env: context.environment, stdio: options.verbose ? "inherit" : "pipe" },
			);
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
