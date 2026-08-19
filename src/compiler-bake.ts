import { hash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { BuildConfigTypeStripper } from "./build-config.ts";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { buildModuleGraph } from "./compiler/frontend/module-graph.ts";
import { hashDirectoryTrees } from "./file-tree.ts";

const COMPILER_WIRE_CACHE = path.join(maligatorCacheDirectory(), "compiler-wire");
const SOURCE_MANIFEST = "artifact.json";

/**
 * Type erasure runs over every compiler source before a bake, so the stripper is
 * part of the bake identity even though the compiler entrypoint never imports it.
 */
const TYPE_STRIPPER_MODULE = "compiler/frontend/compact-type-strip.ts";

/** Third-party packages whose pinned version can change the baked wire. */
const PINNED_COMPILER_DEPENDENCIES = ["meriyah"];

interface CompilerBakeCacheInput {
	/** Compiler-wire cache root. Defaults to the compiler project's cache. */
	cacheRoot?: string;
}

export type CompilerBakeInput =
	| (CompilerBakeCacheInput & {
			kind: "source";
			/** Absolute compiler source directory. */
			sourceDirectory: string;
			/** Absolute source entrypoint compiled by bake. */
			entrypoint: string;
			/** Exact compiler-owned source cone; omitted for conservative tree hashing. */
			sourceFiles?: ReadonlyArray<string>;
			/** Called only when this source identity has no valid cached wire. */
			bake: () => Uint8Array;
	  })
	| (CompilerBakeCacheInput & {
			kind: "bytes";
			bytes: Uint8Array;
	  })
	| (CompilerBakeCacheInput & {
			kind: "prebuilt";
			/** Absolute path to a prebuilt compiler wire. */
			path: string;
	  });

interface SourceManifest {
	schema: 1;
	sourceKey: string;
	outputDigest: string;
}

function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function isCompilerSource(name: string): boolean {
	return [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].some((suffix) =>
		name.endsWith(suffix),
	);
}

function requireAbsolute(description: string, value: string): string {
	if (!path.isAbsolute(value)) {
		throw new Error(`${description} must be absolute: ${value}`);
	}
	return value;
}

function compilerDependencyIdentity(sourceDirectory: string): string {
	const packagePath = path.join(sourceDirectory, "..", "package.json");
	const manifest = JSON.parse(readFileSync(packagePath, "utf-8")) as {
		dependencies?: Record<string, unknown>;
	};
	const parts: Array<string> = [];
	for (const name of PINNED_COMPILER_DEPENDENCIES) {
		const version = manifest.dependencies?.[name];
		if (typeof version !== "string" || version.length === 0) {
			throw new Error(`compiler package does not pin ${name}: ${packagePath}`);
		}
		parts.push(name, "\0", version, "\0");
	}
	return parts.join("");
}

function isWithin(directory: string, target: string): boolean {
	const relative = path.relative(directory, target);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

/** Resolve the compiler-owned static dependency cone for a source bake. */
export function compilerEntrypointSourceFiles(
	sourceDirectory: string,
	entrypoint: string,
	stripTypes: BuildConfigTypeStripper,
): Array<string> {
	const root = requireAbsolute("compiler source directory", sourceDirectory);
	const entry = requireAbsolute("compiler source entrypoint", entrypoint);
	const graphs = [
		buildModuleGraph(entry, { stripTypes }),
		// Compiler-owned ESM, so its goal must not depend on a package.json lookup.
		buildModuleGraph(path.join(root, TYPE_STRIPPER_MODULE), {
			stripTypes,
			entryGoal: "module",
		}),
	];
	const files = new Set<string>();
	for (const graph of graphs) {
		for (const module of graph.modules.values()) {
			if (module.host || module.virtual || !isWithin(root, module.path)) continue;
			files.add(module.path);
		}
	}
	return [...files].sort(compareNames);
}

function compilerSourceHash(
	sourceDirectory: string,
	entrypoint: string,
	sourceFiles?: ReadonlyArray<string>,
): string {
	if (sourceFiles !== undefined) {
		const files = [
			...new Set([...sourceFiles, entrypoint].map((file) => path.resolve(file))),
		]
			.map((file) => {
				if (!isWithin(sourceDirectory, file)) {
					throw new Error(`compiler source file is outside source directory: ${file}`);
				}
				return file;
			})
			.sort((left, right) =>
				compareNames(
					path.relative(sourceDirectory, left),
					path.relative(sourceDirectory, right),
				),
			);
		return hash(
			"sha256",
			[
				"compiler-source-files-v1\0",
				compilerDependencyIdentity(sourceDirectory),
				"entrypoint\0",
				path.relative(sourceDirectory, entrypoint),
				"\0",
				...files.flatMap((file) => [
					path.relative(sourceDirectory, file),
					"\0",
					hash("sha256", readFileSync(file), "hex"),
					"\0",
				]),
			].join(""),
			"hex",
		);
	}
	return hashDirectoryTrees({
		root: sourceDirectory,
		directories: [sourceDirectory],
		include: (entry) => isCompilerSource(entry.name),
		prefix: [
			compilerDependencyIdentity(sourceDirectory),
			"entrypoint\0",
			path.relative(sourceDirectory, entrypoint),
			"\0",
			hash("sha256", readFileSync(entrypoint), "hex"),
			"\0",
		],
		compareNames,
	});
}

function cacheRoot(input: CompilerBakeInput): string {
	if (input.cacheRoot !== undefined) {
		return requireAbsolute("compiler-wire cache root", input.cacheRoot);
	}
	if (input.kind === "source") {
		return path.join(input.sourceDirectory, "..", COMPILER_WIRE_CACHE);
	}
	return path.resolve(COMPILER_WIRE_CACHE);
}

function cacheDirectory(root: string, key: string): string {
	return path.join(root, key);
}

function cachedWire(root: string, key: string): string {
	return path.join(cacheDirectory(root, key), "compiler.malw");
}

function fileDigest(filePath: string): string | undefined {
	try {
		const stats = statSync(filePath);
		if (!stats.isFile() || stats.size === 0) return undefined;
		return hash("sha256", readFileSync(filePath), "hex");
	} catch {
		return undefined;
	}
}

function validContentWire(root: string, digest: string): boolean {
	return fileDigest(cachedWire(root, digest)) === digest;
}

function validSourceWire(root: string, sourceKey: string): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(path.join(cacheDirectory(root, sourceKey), SOURCE_MANIFEST), "utf-8"),
		) as Partial<SourceManifest>;
		return (
			manifest.schema === 1 &&
			manifest.sourceKey === sourceKey &&
			typeof manifest.outputDigest === "string" &&
			fileDigest(cachedWire(root, sourceKey)) === manifest.outputDigest
		);
	} catch {
		return false;
	}
}

function publishFile(directory: string, name: string, bytes: Uint8Array | string): void {
	mkdirSync(directory, { recursive: true });
	const temporaryDirectory = mkdtempSync(path.join(directory, ".publish-"));
	try {
		const temporaryPath = path.join(temporaryDirectory, name);
		writeFileSync(temporaryPath, bytes);
		renameSync(temporaryPath, path.join(directory, name));
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function requireNonemptyWire(bytes: Uint8Array): void {
	if (bytes.byteLength === 0) throw new Error("compiler wire must not be empty");
}

function ensureContentWire(root: string, bytes: Uint8Array): string {
	requireNonemptyWire(bytes);
	const digest = hash("sha256", bytes, "hex");
	const wirePath = cachedWire(root, digest);
	if (!validContentWire(root, digest)) {
		publishFile(cacheDirectory(root, digest), path.basename(wirePath), bytes);
	}
	if (!validContentWire(root, digest)) {
		throw new Error(`failed to publish compiler wire: ${wirePath}`);
	}
	return wirePath;
}

function ensureSourceWire(
	root: string,
	sourceKey: string,
	bake: () => Uint8Array,
): string {
	const wirePath = cachedWire(root, sourceKey);
	if (validSourceWire(root, sourceKey)) return wirePath;
	const bytes = bake();
	requireNonemptyWire(bytes);
	const outputDigest = hash("sha256", bytes, "hex");
	const directory = cacheDirectory(root, sourceKey);
	publishFile(directory, path.basename(wirePath), bytes);
	const manifest: SourceManifest = { schema: 1, sourceKey, outputDigest };
	publishFile(directory, SOURCE_MANIFEST, `${JSON.stringify(manifest)}\n`);
	if (!validSourceWire(root, sourceKey)) {
		throw new Error(`failed to publish compiler wire: ${wirePath}`);
	}
	return wirePath;
}

/** Ensure the requested eval compiler wire is present in the reusable cache. */
export function ensureCompilerWire(input: CompilerBakeInput): string {
	const root = cacheRoot(input);
	if (input.kind === "prebuilt") {
		return ensureContentWire(
			root,
			readFileSync(requireAbsolute("prebuilt compiler wire path", input.path)),
		);
	}
	if (input.kind === "bytes") return ensureContentWire(root, input.bytes);

	const sourceDirectory = requireAbsolute(
		"compiler source directory",
		input.sourceDirectory,
	);
	const entrypoint = requireAbsolute("compiler source entrypoint", input.entrypoint);
	return ensureSourceWire(
		root,
		compilerSourceHash(sourceDirectory, entrypoint, input.sourceFiles),
		input.bake,
	);
}
