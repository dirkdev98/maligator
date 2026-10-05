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
	 * its bound port; it has no public stop method. Invalid timeout/connection limits throw.
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
