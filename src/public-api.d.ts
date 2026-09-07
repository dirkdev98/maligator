/// <reference lib="dom" />

import "./test-api.d.ts";
import "./process-api.d.ts";

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

export type AssetInclusion =
	| { type: "file"; path: string }
	| { type: "directory"; path: string; include: Array<string> };

export interface MaligatorBuildConfig {
	entry?: string;
	outputName?: string;
	assets?: Record<string, AssetInclusion>;
	modules?: {
		/** Exact specifier replacements applied before module resolution. */
		aliases?: Record<string, string>;
	};
	engine?: {
		/**
		 * Lock ECMAScript primordials for this entire build. Locked is the default;
		 * mutable is intended for conformance suites and compatibility experiments.
		 */
		primordials?: "locked" | "mutable";
		/**
		 * `true` embeds the runtime compiler. `false` keeps eval/Function present
		 * but makes dynamic compilation throw at runtime. `"compile-check"` also
		 * rejects statically visible eval/Function calls during the build.
		 */
		eval?: boolean | "compile-check";
		realms?: boolean;
		regexp?: boolean;
		/** Include the Temporal global and its calendar/time-zone data. */
		temporal?: boolean;
		intl?: {
			enabled?: boolean;
			features?: Array<MaligatorIntlFeature>;
			languages?: Array<string>;
		};
	};
	surface?: {
		webPlatform?: boolean;
		node?: boolean;
		maligator?: boolean;
	};
}

export declare function defineBuild<const Config extends MaligatorBuildConfig>(
	config: Config,
): Config;

export interface MaligatorMaterializeOptions {
	baseDirectory?: string;
}

export interface MaligatorAssets {
	materialize(name: string, options?: MaligatorMaterializeOptions): string;
}

export interface MaligatorRuntime {
	readonly assets: MaligatorAssets;
}

export interface MaligatorServeOptions {
	hostname?: string;
	port?: number;
	fetch(request: Request): Response | PromiseLike<Response>;
}

export interface MaligatorServer {
	readonly port: number;
}

export interface MaligatorWebRuntime {
	serve(options: MaligatorServeOptions): MaligatorServer;
}

declare global {
	/**
	 * Maligator's core runtime namespace. Present when
	 * `surface.maligator` is enabled.
	 */
	var mal: MaligatorRuntime;

	/**
	 * Maligator's web-host extension namespace. Present when
	 * `surface.webPlatform` is enabled.
	 */
	var Mal: MaligatorWebRuntime;
}
