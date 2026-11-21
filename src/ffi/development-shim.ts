import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import {
	artifactActionKey,
	artifactDigest,
	artifactFileDigest,
	artifactOutput,
	artifactProducer,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "../artifact-store.ts";
import { ccExtraFlags, platformLinkArgs, sanitizerMode } from "../build-flags.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import { nativeBuildEnvironmentFingerprint } from "../native-build-context.ts";
import { toolArguments } from "../toolchain.ts";
import { generateBindingUnit } from "./binding-unit.ts";
import { FFI_C_STANDARD } from "./c-extract.ts";
import { libraryLinkArguments } from "./discovery.ts";
import { FfiSourceChangedError } from "./ffi-error.ts";
import type { LibraryPreparation, PreparedLibrary } from "./library.ts";

const STAGE = "ffi-development-shim";
const PRODUCER = artifactProducer(STAGE, 1, "cc");

type ShimBuildOptions = Pick<
	LibraryPreparation,
	"compiler" | "environment" | "platform" | "cross"
> & {
	readonly runtimeDirectory: string;
	readonly cacheDirectory?: string;
};

export type DevelopmentShim =
	| { library: string; kind: "shim"; path: string }
	| { library: string; kind: "linked"; reason: string };

function linkedReason(
	entry: PreparedLibrary,
	options: ShimBuildOptions,
	sharedSource: string | undefined,
): string | undefined {
	if (options.cross || (options.platform !== "darwin" && options.platform !== "linux"))
		return "development library loading requires a macOS or Linux host build";
	if (entry.contract.link === "static") return 'the contract requests link: "static"';
	if (sanitizerMode(options.environment) !== "none") return "the runner uses a sanitizer";
	if (sharedSource !== undefined)
		return `multiple contracts compile the same C source (${sharedSource})`;
	for (const input of entry.library.linkInputs) {
		if (input.kind === "archive")
			return `the library links a static archive (${input.path})`;
		// Flags such as interposition, force-loading and constructor ordering affect
		// the whole executable. Only pass flags with well-defined local behaviour.
		if (input.kind === "flag" && input.value !== "-pthread")
			return `the library uses linker flag ${input.value}`;
	}
	return undefined;
}

/** Build each independently loadable binding and identify contracts that need one executable link. */
export function buildDevelopmentShims(
	libraries: ReadonlyArray<PreparedLibrary>,
	options: ShimBuildOptions,
): Array<DevelopmentShim> {
	const sourceOwners = new Map<string, string>();
	const sharedSources = new Map<string, string>();
	for (const entry of libraries) {
		for (const source of entry.library.sources) {
			const canonical = realpathSync(source);
			const name = entry.contract.name;
			const owner = sourceOwners.get(canonical);
			if (owner === undefined) sourceOwners.set(canonical, name);
			else if (owner !== name) {
				sharedSources.set(owner, source);
				sharedSources.set(name, source);
			}
		}
	}
	return libraries.map((entry) => {
		const name = entry.contract.name;
		const reason = linkedReason(entry, options, sharedSources.get(name));
		return reason === undefined
			? buildDevelopmentShim(entry, options)
			: { library: name, kind: "linked", reason };
	});
}

function buildDevelopmentShim(
	entry: PreparedLibrary,
	options: ShimBuildOptions,
): DevelopmentShim {
	const library = entry.contract.name;
	const root = options.cacheDirectory ?? maligatorCacheDirectory();
	const bindingsDirectory = path.join(options.runtimeDirectory, "src/ffi");
	const platform = options.platform;
	const compileArguments = [
		...ccExtraFlags(undefined, options.environment, platform),
		"-fPIC",
		"-fvisibility=hidden",
	];
	const linkerArguments =
		platform === "darwin"
			? ["-bundle", "-Wl,-undefined,error", "-Wl,-exported_symbol,_mal_ffi_shim_register"]
			: ["-shared", "-Wl,-z,defs"];
	const files = [
		...new Set([
			entry.contract.path,
			...entry.model.dependencies,
			...entry.library.sources,
			...entry.library.linkInputs.flatMap((input) =>
				input.kind === "shared" ? [input.path] : [],
			),
			...["mal_ffi.h", "mal_ffi_api.h", "mal_ffi_shim.h"].map((file) =>
				path.join(bindingsDirectory, file),
			),
		]),
	].sort();
	const fileDigests = files.map((file) => [file, artifactFileDigest(file)] as const);
	const binding = generateBindingUnit(
		library,
		entry.contract.headers,
		entry.model,
		entry.plan,
	);
	const key = artifactActionKey(PRODUCER, {
		library,
		binding: artifactDigest(binding.source),
		target: entry.model.target,
		compileArguments,
		libraryCompileArguments: entry.library.compileArguments,
		linkerArguments,
		linkInputs: entry.library.linkInputs,
		sources: entry.library.sources,
		files: fileDigests,
		compiler: options.compiler,
		environment: nativeBuildEnvironmentFingerprint(options.environment),
	});
	const reuse = (): DevelopmentShim | undefined => {
		const found = readArtifactAction(root, STAGE, PRODUCER, key);
		if (found === undefined) return undefined;
		return { library, kind: "shim", path: artifactOutput(found, "shim").path };
	};
	return (
		reuse() ??
		withArtifactActionLock(root, STAGE, PRODUCER, key, () => {
			const cached = reuse();
			if (cached !== undefined) return cached;
			const workRoot = path.join(root, "work");
			mkdirSync(workRoot, { recursive: true });
			const work = mkdtempSync(path.join(workRoot, "ffi-shim-"));
			try {
				const bindingSource = path.join(work, "binding.c");
				writeFileSync(
					bindingSource,
					`#define MAL_FFI_BUILD_SHIM 1
#include "mal_ffi_shim.h"
${binding.source}
__attribute__((visibility("default")))
const MalFfiShimBinding *mal_ffi_shim_register(
    unsigned abi, size_t runtime_size, const MalFfiShimRuntime *runtime) {
    static const MalFfiShimBinding binding = { "${binding.installer}", ${binding.installer} };
    return mal_ffi_shim_bind_runtime(abi, runtime_size, runtime) ? &binding : nullptr;
}
`,
				);
				const exports = path.join(work, "exports");
				if (platform === "linux")
					writeFileSync(exports, "{ global: mal_ffi_shim_register; local: *; };\n");
				const output = path.join(work, "shim");
				const invoke = (args: Array<string>): string | undefined => {
					const result = spawnSync(
						options.compiler.path,
						toolArguments(options.compiler, args),
						{
							env: options.environment,
							encoding: "utf-8",
							stdio: ["ignore", "ignore", "pipe"],
						},
					);
					if (result.error !== undefined) throw result.error;
					if (result.signal !== null)
						throw new Error(`C library shim compiler received ${result.signal}`);
					return result.status === 0
						? undefined
						: result.stderr.trim().slice(-2048) || `exit ${result.status}`;
				};
				const objects: Array<string> = [];
				for (const [index, source] of [
					bindingSource,
					...entry.library.sources,
				].entries()) {
					const object = path.join(work, `${index}.o`);
					const failure = invoke([
						...(index === 0 ? [FFI_C_STANDARD, "-I", bindingsDirectory] : []),
						...entry.library.compileArguments,
						...compileArguments,
						"-c",
						source,
						"-o",
						object,
					]);
					if (failure !== undefined)
						return {
							library,
							kind: "linked",
							reason: `PIC compilation failed (${failure})`,
						};
					objects.push(object);
				}
				const failure = invoke([
					...compileArguments,
					...linkerArguments,
					...(platform === "linux" ? [`-Wl,--version-script=${exports}`] : []),
					...objects,
					...entry.library.linkInputs.flatMap(libraryLinkArguments),
					...platformLinkArgs(platform),
					"-o",
					output,
				]);
				if (failure !== undefined)
					return {
						library,
						kind: "linked",
						reason: `the shared shim link failed (${failure})`,
					};
				const changed = fileDigests.flatMap(([file, digest]) =>
					!existsSync(file) || artifactFileDigest(file) !== digest ? [file] : [],
				);
				if (changed.length > 0) throw new FfiSourceChangedError(changed);
				const action = publishArtifactAction(root, STAGE, PRODUCER, key, [
					{ name: "shim", file: output },
				]);
				return { library, kind: "shim", path: artifactOutput(action, "shim").path };
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		})
	);
}

export function developmentShimArguments(shims: ReadonlyArray<string>): Array<string> {
	return shims.length === 0
		? []
		: ["--maligator-internal-ffi-shims", String(shims.length), ...shims];
}
