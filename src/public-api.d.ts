/// <reference lib="dom" />

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
	engine?: {
		eval?: boolean;
		realms?: boolean;
		regexp?: boolean;
		intl?: {
			enabled?: boolean;
			features?: Array<MaligatorIntlFeature>;
			languages?: Array<string>;
		};
	};
	host?: {
		scheduler?: "single" | "multiprocessing";
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
