import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { LibraryContract, ResolvedFind } from "./contract.ts";
import { FfiError } from "./ffi-error.ts";

/** One linker input of a resolved library, kept structured for cache identity. */
export type LinkInput =
	| { readonly kind: "archive"; readonly path: string }
	| {
			readonly kind: "shared";
			readonly path: string;
			readonly name: string;
			readonly directory: string;
	  }
	/** A library the linker finds on its default search path, such as `m`. */
	| { readonly kind: "system"; readonly name: string }
	| { readonly kind: "framework"; readonly name: string }
	/** A pkg-config linker flag passed through, such as `-pthread`. */
	| { readonly kind: "flag"; readonly value: string };

export interface ResolvedLibrary {
	readonly name: string;
	readonly method: "pkg-config" | "paths" | "sources";
	readonly package?: string;
	readonly version?: string;
	/** Arguments that let the headers and sources compile: include paths, defines, flags. */
	readonly compileArguments: ReadonlyArray<string>;
	readonly link: "static" | "shared";
	readonly linkInputs: ReadonlyArray<LinkInput>;
	/** C sources compiled into the program. */
	readonly sources: ReadonlyArray<string>;
}

export interface DiscoveryOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	/** Cross builds cannot use the host's pkg-config database. */
	readonly cross: boolean;
}

/** Split pkg-config output the way a POSIX shell would, honouring quotes and escapes. */
export function splitFlags(text: string): Array<string> {
	const tokens: Array<string> = [];
	let current = "";
	let inToken = false;
	let quote: string | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && index + 1 < text.length)
				current += text[++index];
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inToken = true;
		} else if (char === "\\" && index + 1 < text.length) {
			current += text[++index];
			inToken = true;
		} else if (/\s/.test(char)) {
			if (inToken) tokens.push(current);
			current = "";
			inToken = false;
		} else {
			current += char;
			inToken = true;
		}
	}
	if (inToken) tokens.push(current);
	return tokens;
}

class Unresolved extends Error {}

function pkgConfig(options: DiscoveryOptions, args: ReadonlyArray<string>): string {
	const executable = options.environment.PKG_CONFIG?.trim() || "pkg-config";
	const result = spawnSync(executable, [...args], {
		env: options.environment,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error !== undefined) {
		throw new Unresolved(`cannot run ${executable}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Unresolved(
			`${executable} ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
		);
	}
	return result.stdout.trim();
}

interface LinkFlags {
	readonly libraryDirs: Array<string>;
	readonly libraries: Array<string>;
	readonly frameworks: Array<string>;
	readonly flags: Array<string>;
	readonly files: Array<string>;
}

function parseLinkFlags(tokens: ReadonlyArray<string>): LinkFlags {
	const parsed: LinkFlags = {
		libraryDirs: [],
		libraries: [],
		frameworks: [],
		flags: [],
		files: [],
	};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "-L" || token === "-l" || token === "-framework") {
			const value = tokens[++index];
			if (value === undefined) throw new Unresolved(`'${token}' without a value`);
			if (token === "-L") parsed.libraryDirs.push(value);
			else if (token === "-l") parsed.libraries.push(value);
			else parsed.frameworks.push(value);
		} else if (token.startsWith("-L")) parsed.libraryDirs.push(token.slice(2));
		else if (token.startsWith("-l")) parsed.libraries.push(token.slice(2));
		else if (token.startsWith("-")) parsed.flags.push(token);
		else parsed.files.push(token);
	}
	return parsed;
}

function compileArgumentsFromFlags(tokens: ReadonlyArray<string>): Array<string> {
	const result: Array<string> = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		const value = tokens[index + 1];
		if ((token === "-I" || token === "-D") && value !== undefined) {
			result.push(`${token}${value}`);
			index++;
		} else if (token === "-isystem" && value !== undefined) {
			result.push(token, value);
			index++;
		} else if (!token.startsWith("-std=")) {
			// Binding units compile as C23, so a package's own language standard cannot apply.
			result.push(token);
		}
	}
	return result;
}

function sharedExtensions(platform: NodeJS.Platform): ReadonlyArray<string> {
	return platform === "darwin" ? [".dylib", ".tbd"] : [".so"];
}

function findLibraryFile(
	name: string,
	directories: ReadonlyArray<string>,
	extensions: ReadonlyArray<string>,
): { path: string; directory: string } | undefined {
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = path.join(directory, `lib${name}${extension}`);
			if (existsSync(candidate)) return { path: candidate, directory };
		}
	}
	return undefined;
}

function linkInputs(
	primary: ReadonlyArray<string>,
	dependencies: ReadonlyArray<string>,
	libraryDirs: ReadonlyArray<string>,
	frameworks: ReadonlyArray<string>,
	flags: ReadonlyArray<string>,
	files: ReadonlyArray<string>,
	requested: "static" | "shared" | undefined,
	platform: NodeJS.Platform,
): { link: "static" | "shared"; inputs: Array<LinkInput> } {
	const archives = new Map(
		primary.map((name) => [name, findLibraryFile(name, libraryDirs, [".a"])] as const),
	);
	const shared = new Map(
		primary.map(
			(name) =>
				[name, findLibraryFile(name, libraryDirs, sharedExtensions(platform))] as const,
		),
	);
	const located = primary.filter(
		(name) => archives.get(name) !== undefined || shared.get(name) !== undefined,
	);
	const link =
		requested ??
		(located.length > 0 && located.every((name) => archives.get(name) !== undefined)
			? "static"
			: "shared");
	if (link === "static") {
		const missing = primary.filter((name) => archives.get(name) === undefined);
		if (missing.length > 0) {
			throw new Unresolved(
				`no static archive for ${missing.map((name) => `lib${name}.a`).join(", ")} in ${libraryDirs.join(", ") || "the configured library directories"}`,
			);
		}
	}
	const inputs: Array<LinkInput> = [];
	const seen = new Set<string>();
	const add = (name: string, preferStatic: boolean): void => {
		if (seen.has(name)) return;
		seen.add(name);
		const archive = preferStatic ? findLibraryFile(name, libraryDirs, [".a"]) : undefined;
		if (archive !== undefined) {
			inputs.push({ kind: "archive", path: archive.path });
			return;
		}
		const library = findLibraryFile(name, libraryDirs, sharedExtensions(platform));
		inputs.push(
			library === undefined
				? { kind: "system", name }
				: { kind: "shared", path: library.path, name, directory: library.directory },
		);
	};
	for (const name of primary) add(name, link === "static");
	// Shared libraries carry their own dependencies; archives need them on the link line.
	if (link === "static") for (const name of dependencies) add(name, true);
	for (const file of files) {
		inputs.push(
			file.endsWith(".a")
				? { kind: "archive", path: file }
				: {
						kind: "shared",
						path: file,
						name: path.basename(file),
						directory: path.dirname(file),
					},
		);
	}
	for (const name of frameworks) inputs.push({ kind: "framework", name });
	for (const value of flags) inputs.push({ kind: "flag", value });
	return { link, inputs };
}

function resolveAlternative(
	library: LibraryContract,
	find: ResolvedFind,
	options: DiscoveryOptions,
): ResolvedLibrary {
	for (const source of find.sources) {
		if (!existsSync(source)) throw new Unresolved(`source not found: ${source}`);
	}
	for (const directory of find.includeDirs) {
		if (!existsSync(directory))
			throw new Unresolved(`include directory not found: ${directory}`);
	}
	const explicitCompile = [
		...find.includeDirs.map((directory) => `-I${directory}`),
		...Object.entries(find.defines).map(([name, value]) =>
			value === "" ? `-D${name}` : `-D${name}=${value}`,
		),
	];
	const frameworks = [...find.frameworks];
	if (frameworks.length > 0 && options.platform !== "darwin") {
		throw new Unresolved("frameworks are only available on macOS");
	}

	if (find.pkgConfig !== undefined) {
		if (options.cross) {
			throw new Unresolved(
				"pkg-config describes host libraries; cross builds need includeDirs and libraries or sources",
			);
		}
		const name = find.pkgConfig;
		const version = pkgConfig(options, ["--modversion", name]);
		const cflags = splitFlags(pkgConfig(options, ["--cflags", name]));
		const libs = parseLinkFlags(splitFlags(pkgConfig(options, ["--libs", name])));
		const staticLibs = parseLinkFlags(
			splitFlags(pkgConfig(options, ["--static", "--libs", name])),
		);
		const libraryDirs = [
			...new Set([...find.libraryDirs, ...libs.libraryDirs, ...staticLibs.libraryDirs]),
		];
		const primary = [...new Set([...libs.libraries, ...find.libraries])];
		const resolved = linkInputs(
			primary,
			staticLibs.libraries.filter((entry) => !primary.includes(entry)),
			libraryDirs,
			[...new Set([...frameworks, ...libs.frameworks, ...staticLibs.frameworks])],
			[...new Set([...libs.flags, ...staticLibs.flags])],
			libs.files,
			library.link,
			options.platform,
		);
		if (find.sources.length > 0 && resolved.link === "shared") {
			throw new Unresolved("sources always link statically");
		}
		return {
			name: library.name,
			method: "pkg-config",
			package: name,
			version,
			compileArguments: [...compileArgumentsFromFlags(cflags), ...explicitCompile],
			link: resolved.link,
			linkInputs: resolved.inputs,
			sources: find.sources,
		};
	}

	if (find.libraries.length > 0) {
		const resolved = linkInputs(
			find.libraries,
			[],
			find.libraryDirs,
			frameworks,
			[],
			[],
			library.link,
			options.platform,
		);
		if (find.sources.length > 0 && resolved.link === "shared") {
			throw new Unresolved("sources always link statically");
		}
		return {
			name: library.name,
			method: "paths",
			compileArguments: explicitCompile,
			link: resolved.link,
			linkInputs: resolved.inputs,
			sources: find.sources,
		};
	}

	if (library.link === "shared") throw new Unresolved("sources always link statically");
	return {
		name: library.name,
		method: "sources",
		compileArguments: explicitCompile,
		link: "static",
		linkInputs: frameworks.map((framework) => ({ kind: "framework", name: framework })),
		sources: find.sources,
	};
}

/** Resolve the first discovery alternative that works on this machine. */
export function resolveLibrary(
	library: LibraryContract,
	options: DiscoveryOptions,
): ResolvedLibrary {
	const failures: Array<string> = [];
	for (const find of library.find) {
		try {
			return resolveAlternative(library, find, options);
		} catch (error) {
			if (!(error instanceof Unresolved)) throw error;
			failures.push(error.message);
		}
	}
	throw new FfiError(
		`cannot find the C library '${library.name}':\n${failures.map((failure) => `  - ${failure}`).join("\n")}`,
	);
}
