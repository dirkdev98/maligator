import { resolveBuildConfig } from "../build-config-values.ts";

export const EXPLORER_SCHEMA = 2;
export type ExplorerLanguage = "javascript" | "typescript";

export function normalizeExplorerLanguage(
	value: unknown = "javascript",
): ExplorerLanguage {
	if (value !== "javascript" && value !== "typescript")
		throw new Error("Invalid explorer language");
	return value;
}

export function explorerSourcePath(language: ExplorerLanguage): string {
	return `output-explorer/snippet.${language === "typescript" ? "ts" : "js"}`;
}
export const EXPLORER_LIMITS = Object.freeze({
	sourceBytes: 64 * 1024,
	outputBytes: 8 * 1024 * 1024,
	compileMs: 10_000,
	loadMs: 30_000,
	memoryBytes: 256 * 1024 * 1024,
	recycleBytes: 128 * 1024 * 1024,
	idleMs: 5 * 60_000,
	cacheEntries: 8,
	cacheBytes: 16 * 1024 * 1024,
});

export interface ExplorerConfig {
	primordials: "locked" | "mutable";
	eval: boolean | "compile-check";
	regexp: boolean;
	realms: boolean;
	temporal: boolean;
	intl: boolean;
	webPlatform: boolean;
	node: boolean;
	maligator: boolean;
}

export const EXPLORER_DEFAULT_CONFIG: Readonly<ExplorerConfig> = Object.freeze({
	primordials: "locked",
	eval: "compile-check",
	regexp: false,
	realms: false,
	temporal: false,
	intl: false,
	webPlatform: false,
	node: false,
	maligator: false,
});

export function normalizeExplorerConfig(value: unknown): ExplorerConfig {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected explorer settings to be an object");
	}
	const config = { ...EXPLORER_DEFAULT_CONFIG };
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (key === "primordials") {
			if (entry !== "locked" && entry !== "mutable")
				throw new Error("Invalid primordial policy");
			config.primordials = entry;
		} else if (key === "eval") {
			if (typeof entry !== "boolean" && entry !== "compile-check")
				throw new Error("Invalid eval policy");
			config.eval = entry;
		} else if (
			key === "regexp" ||
			key === "realms" ||
			key === "temporal" ||
			key === "intl" ||
			key === "webPlatform" ||
			key === "node" ||
			key === "maligator"
		) {
			if (typeof entry !== "boolean") throw new Error(`Expected ${key} to be on or off`);
			config[key] = entry;
		} else {
			throw new Error(`Unknown explorer setting: ${key}`);
		}
	}
	return config;
}

export function explorerBuildConfig(config: ExplorerConfig) {
	return resolveBuildConfig({
		engine: {
			primordials: config.primordials,
			eval: config.eval,
			regexp: config.regexp,
			realms: config.realms,
			temporal: config.temporal,
			intl: { enabled: config.intl },
		},
		surface: {
			webPlatform: config.webPlatform,
			node: config.node,
			maligator: config.maligator,
		},
	});
}

export function utf8ByteLength(value: string): number {
	let length = 0;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return length;
}
