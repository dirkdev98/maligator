/// <reference lib="dom" />

import "./platform-api.d.ts";

/** Service selections used when Intl is enabled; an empty list includes every service. */
export type MaligatorIntlFeature =
	| "collator"
	| "number-format"
	| "date-time-format"
	| "plural-rules"
	| "list-format"
	| "segmenter"
	| "display-names"
	| "relative-time-format"
	| "duration-format";

/**
 * Capture a regular file or a directory tree at build time. Paths are relative to
 * the project root. Directory patterns support *, ?, and whole-segment **;
 * every pattern must match a regular file. Symlinks are rejected.
 * @see https://maligator.ddv.tools/api/build#AssetInclusion
 */
export type AssetInclusion =
	| { type: "file"; path: string }
	| { type: "directory"; path: string; include: Array<string> };

/**
 * How the build finds a C library's headers and binaries. Relative paths resolve
 * against the file that declares them. Name at least `pkgConfig`, `libraries`, or
 * `sources`; the other fields add to what those provide.
 * @see https://maligator.ddv.tools/api/build#MaligatorFfiFind
 */
export interface MaligatorFfiFind {
	/** A pkg-config package that supplies include directories and linker inputs. */
	pkgConfig?: string;
	/** Header search directories. */
	includeDirs?: Array<string>;
	/** Preprocessor definitions for the headers and sources. */
	defines?: Record<string, string>;
	/** Directories searched for `libraries`. */
	libraryDirs?: Array<string>;
	/** Libraries linked by name, as with `-lname`. */
	libraries?: Array<string>;
	/** macOS frameworks to link, such as `Cocoa`. */
	frameworks?: Array<string>;
	/** C sources compiled into the program instead of a prebuilt library. */
	sources?: Array<string>;
}

/**
 * A C library the program imports as `maligator:ffi/<name>`.
 * @see https://maligator.ddv.tools/api/build#MaligatorFfiLibrary
 */
export interface MaligatorFfiLibrary {
	/** Project-root-relative path to the library's contract, a module exporting `defineLibrary(...)`. */
	contract: string;
	/** Machine-specific discovery that replaces the contract's `find` alternatives. */
	find?: MaligatorFfiFind;
	/** Link the static archive or the shared library. Without a choice, the build links
	 * statically when every library has an archive. Sources always link statically.
	 */
	link?: "static" | "shared";
}

/**
 * A C type whose values are resources the program opens and closes. Its handles
 * close on `[Symbol.dispose]()` or when passed to `destroy`; a closed handle throws
 * instead of reaching C.
 * @see https://maligator.ddv.tools/api/build#MaligatorFfiHandle
 */
export interface MaligatorFfiHandle {
	/** The function that releases the resource, taking it as its first parameter. */
	destroy?: string;
	/** Release a handle the program never closed once it is garbage collected. Off unless
	 * set; leave it off for resources that must be released on one thread or before the
	 * library shuts down.
	 */
	collect?: boolean;
}

/** Facts about one C type, keyed by its typedef or struct tag. */
export interface MaligatorFfiTypeFacts {
	handle?: MaligatorFfiHandle;
}

/** The parameter that carries the size of a buffer or array. */
export interface MaligatorFfiCount {
	/**
	 * The parameter's C name, or its 1-based position. For a result, the count comes
	 * from an integer parameter or from an integer the function writes through a pointer.
	 */
	length: string;
}

/** Facts about a parameter or a result. */
export interface MaligatorFfiValueFacts {
	/** Accept `null` for a pointer parameter and pass `NULL`. */
	nullable?: boolean;
	/** A returned handle the library keeps owning; closing it does not release it. */
	borrowed?: boolean;
	/** The function writes a value through this pointer; it returns beside the result. */
	out?: boolean;
	/** The function reads and updates the value behind this pointer; the new value returns beside the result. */
	inout?: boolean;
	/** A `char *` or `unsigned char *` that holds UTF-8 text. */
	string?: boolean;
	/** Bytes passed as an `ArrayBuffer` or a view, or returned as a new `Uint8Array`. */
	bytes?: MaligatorFfiCount;
	/** Elements passed or returned as an array. */
	array?: MaligatorFfiCount;
	/** Release a copied string, buffer, or array result with this function. */
	free?: string;
	/** A function pointer the library calls during the call with a JavaScript function. */
	callback?: MaligatorFfiCallback;
}

/**
 * A callback the library calls before the function returns, such as an iteration or
 * comparison function. An exception it throws skips its later calls and rethrows when
 * the C function returns.
 */
export interface MaligatorFfiCallback {
	/** The `void *` parameter the library passes back to the callback, by C name or 1-based position. */
	data: string;
}

/** Facts about one C function, keyed by its name. */
export interface MaligatorFfiFunctionFacts {
	/** Facts per parameter, keyed by C name or by 1-based position for unnamed ones. */
	params?: Record<string, MaligatorFfiValueFacts>;
	returns?: MaligatorFfiValueFacts;
	/**
	 * Functions that call a variadic function with fixed argument types, keyed by the
	 * name each is exported as. The function's own facts apply to every variant.
	 */
	variants?: Record<string, MaligatorFfiVariant>;
}

/** One way to call a variadic function: the C types of the arguments after the fixed ones. */
export interface MaligatorFfiVariant {
	/** C type spellings, such as `int` or `const char *`; arguments are named `arg<position>`. */
	args: Array<string>;
	/** Facts for the variadic arguments, keyed by `arg<position>` or by 1-based position. */
	params?: Record<string, MaligatorFfiValueFacts>;
}

/**
 * Facts about a C library that hold wherever it is installed. The binding comes from
 * the headers plus these facts.
 * @see https://maligator.ddv.tools/api/build#MaligatorLibraryContract
 */
export interface MaligatorLibraryContract {
	/** Headers to bind, spelled as C code includes them, such as `raylib.h` or `curl/curl.h`. */
	headers: Array<string>;
	/** Discovery alternatives, tried in order. A build config `find` replaces them. */
	find?: Array<MaligatorFfiFind>;
	/** Facts about types, keyed by typedef or struct tag. */
	types?: Record<string, MaligatorFfiTypeFacts>;
	/** Facts about functions, keyed by name. */
	functions?: Record<string, MaligatorFfiFunctionFacts>;
}

/** Trusted, strictly validated configuration evaluated for each CLI invocation.
 * @see https://maligator.ddv.tools/guides/build-configuration
 */
export interface MaligatorBuildConfig {
	/** Project-root-relative entry; an explicit CLI entry takes precedence. */
	entry?: string;
	/** Binary name; otherwise inferred from the unscoped package name or project directory. */
	outputName?: string;
	/** Named build-time snapshots. Requires surface.maligator; portable serialized images cannot carry these filesystem resources. */
	assets?: Record<string, AssetInclusion>;
	modules?: {
		/** Exact specifier replacements applied before module resolution. Defaults to an empty map. */
		aliases?: Record<string, string>;
	};
	engine?: {
		/** Lock built-in objects for the entire build. Mutable is intended for compatibility experiments.
		 * @default "locked"
		 */
		primordials?: "locked" | "mutable";
		/** Control dynamic compilation. false leaves eval/Function present but makes calls throw;
		 * true embeds the compiler; compile-check also rejects statically visible calls at build time.
		 * @default false
		 * @see https://maligator.ddv.tools/api/build#engine.eval
		 */
		eval?: boolean | "compile-check";
		/** Include Realm support.
		 * @default false
		 */
		realms?: boolean;
		/** Include RegExp; disabling it trades compatibility for binary size.
		 * @default true
		 */
		regexp?: boolean;
		/** Include Temporal and its calendar/time-zone data.
		 * @default false
		 */
		temporal?: boolean;
		intl?: {
			/** Include internationalization services and their native data.
			 * @default false
			 */
			enabled?: boolean;
			/** Select services. An empty list includes all services when enabled.
			 * @default []
			 */
			features?: Array<MaligatorIntlFeature>;
			/** Locale-data filtering is not implemented; only an empty list is accepted.
			 * @default []
			 */
			languages?: Array<string>;
		};
	};
	surface?: {
		/** Include Web APIs and Mal.serve. Declarations alone do not enable them.
		 * @default false
		 */
		webPlatform?: boolean;
		/** Include supported node: modules; see the compatibility table for coverage.
		 * @default false
		 */
		node?: boolean;
		/** Include the mal namespace. Required for configured assets.
		 * @default true
		 */
		maligator?: boolean;
	};
	/** C libraries keyed by the name the program imports them under (`maligator:ffi/<name>`).
	 * Names use lowercase letters, digits, and underscores.
	 * @see https://maligator.ddv.tools/guides/c-libraries
	 */
	ffi?: Record<string, MaligatorFfiLibrary>;
}

/** Preserve the inferred config type. Validation happens when the CLI loads the config.
 * @example
 * import { defineBuild } from "@maligator/cli";
 * export default defineBuild({ entry: "src/index.ts" });
 * @see https://maligator.ddv.tools/api/build#defineBuild
 */
export declare function defineBuild<const Config extends MaligatorBuildConfig>(
	config: Config,
): Config;

/** Preserve the inferred contract type. Validation happens when the CLI loads the contract.
 * @example
 * import { defineLibrary } from "@maligator/cli";
 * export default defineLibrary({ headers: ["raylib.h"], find: [{ pkgConfig: "raylib" }] });
 * @see https://maligator.ddv.tools/api/build#defineLibrary
 */
export declare function defineLibrary<const Contract extends MaligatorLibraryContract>(
	contract: Contract,
): Contract;

export interface MaligatorMaterializeOptions {
	/** Parent directory for the content-addressed materialization. Defaults to the OS temporary directory. */
	baseDirectory?: string;
}

export interface MaligatorAssets {
	/**
	 * Atomically write a named snapshot and return its absolute file/directory path.
	 * Completed materializations are reused by content identity. Unknown names,
	 * invalid options, and filesystem failures throw synchronously.
	 * @see https://maligator.ddv.tools/api/runtime#mal.assets.materialize
	 */
	materialize(name: string, options?: MaligatorMaterializeOptions): string;
}

export interface MaligatorRuntime {
	readonly assets: MaligatorAssets;
}

export interface MaligatorServeOptions {
	/** Bind address. Defaults to 0.0.0.0; use 127.0.0.1 for a local-only listener. */
	hostname?: string;
	/** TCP port, 0 through 65535. Defaults to 0, which asks the OS to choose a port. */
	port?: number;
	/** Handle a request with a Response or an awaited response. */
	fetch(request: Request): Response | PromiseLike<Response>;
	/** Header deadline in milliseconds; 0 also selects the default. Integer 0..2147483647.
	 * @default 60000 */
	headersTimeout?: number;
	/** Request deadline in milliseconds; 0 also selects the default. Integer 0..2147483647.
	 * @default 300000 */
	requestTimeout?: number;
	/** Idle keep-alive deadline in milliseconds; 0 also selects the default. Integer 0..2147483647.
	 * @default 5000 */
	keepAliveTimeout?: number;
	/** Concurrent connection limit; 0 also selects the default. Integer 0..2147483647.
	 * @default 1024 */
	maxConnections?: number;
}

export interface MaligatorServer {
	/** Actual bound port, including an OS-selected port when the requested port was 0. */
	readonly port: number;
}

export interface MaligatorWebRuntime {
	/**
	 * Start an HTTP listener. Requires surface.webPlatform. The current handle exposes
	 * its bound port; it has no public stop method. Invalid timeout/connection limits throw,
	 * as does a hostname that is not ASCII or is 64 characters or longer.
	 * @see https://maligator.ddv.tools/api/runtime#Mal.serve
	 */
	serve(options: MaligatorServeOptions): MaligatorServer;
}

declare global {
	/** Core namespace, available when surface.maligator is enabled.
	 * @see https://maligator.ddv.tools/api/runtime#mal
	 */
	var mal: MaligatorRuntime;
	/** Web host namespace, available when surface.webPlatform is enabled.
	 * @see https://maligator.ddv.tools/api/runtime#Mal
	 */
	var Mal: MaligatorWebRuntime;
}
