import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { DisallowedEvalUsage } from "./semantic-analysis.ts";

/**
 * The `maligator.build.json` build configuration (GitHub issue #2). The file is
 * the source of truth for engine capabilities, host execution mode, and the API
 * surface exposed to user code. Only `engine.eval` is acted on today; the rest of
 * the shape is parsed and validated (so the format is stable and typos are caught)
 * but does not yet change compilation.
 *
 * Every field is optional in the file — {@link resolveBuildConfig} fills defaults.
 * Defaults are deliberately conservative (the "product" defaults): eval OFF, Intl
 * OFF, single-threaded scheduler, only the Maligator surface. Internal tooling
 * (the native test harness, the eval self-host scripts, the test262 runner) opts
 * back in explicitly.
 */
export interface MaligatorBuildConfig {
	entry?: string;
	engine?: {
		eval?: boolean;
		intl?: {
			enabled?: boolean;
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

/** A build config with every default applied — what the compiler consumes. */
export interface ResolvedBuildConfig {
	entry: string | undefined;
	engine: {
		eval: boolean;
		intl: { enabled: boolean; languages: Array<string> };
	};
	host: { scheduler: "single" | "multiprocessing" };
	surface: { webPlatform: boolean; node: boolean; maligator: boolean };
}

/** Thrown for a malformed / mistyped `maligator.build.json`, with a clear reason. */
export class BuildConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BuildConfigError";
	}
}

/**
 * A schema node: the allowed keys at this level and, per key, either a leaf value
 * validator or a nested object schema. Any key not listed is a hard error — the
 * whole point of the config is to be small and understandable, so a typo should
 * fail loudly rather than be silently ignored.
 */
type Leaf = { leaf: (value: unknown, at: string) => void };
type ObjectSchema = { object: Record<string, Leaf | ObjectSchema> };
type SchemaNode = Leaf | ObjectSchema;

function isObjectSchema(node: SchemaNode): node is ObjectSchema {
	return "object" in node;
}

function expect(condition: boolean, at: string, expected: string): void {
	if (!condition) {
		throw new BuildConfigError(`maligator.build.json: '${at}' must be ${expected}`);
	}
}

const booleanLeaf: Leaf = {
	leaf: (value, at) => expect(typeof value === "boolean", at, "a boolean"),
};
const stringLeaf: Leaf = {
	leaf: (value, at) => expect(typeof value === "string", at, "a string"),
};
const stringArrayLeaf: Leaf = {
	leaf: (value, at) =>
		expect(
			Array.isArray(value) && value.every((item) => typeof item === "string"),
			at,
			"an array of strings",
		),
};
const schedulerLeaf: Leaf = {
	leaf: (value, at) =>
		expect(
			value === "single" || value === "multiprocessing",
			at,
			`"single" or "multiprocessing"`,
		),
};

const CONFIG_SCHEMA: ObjectSchema = {
	object: {
		entry: stringLeaf,
		engine: {
			object: {
				eval: booleanLeaf,
				intl: { object: { enabled: booleanLeaf, languages: stringArrayLeaf } },
			},
		},
		host: { object: { scheduler: schedulerLeaf } },
		surface: {
			object: { webPlatform: booleanLeaf, node: booleanLeaf, maligator: booleanLeaf },
		},
	},
};

/** Validate `value` against `schema`, rejecting unknown keys and wrong types. */
function validate(value: unknown, schema: SchemaNode, at: string): void {
	if (isObjectSchema(schema)) {
		expect(
			typeof value === "object" && value !== null && !Array.isArray(value),
			at,
			"an object",
		);
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			const childSchema = schema.object[key];
			if (!childSchema) {
				const allowed = Object.keys(schema.object).join(", ");
				throw new BuildConfigError(
					`maligator.build.json: unknown key '${at === "" ? key : `${at}.${key}`}' (allowed: ${allowed})`,
				);
			}
			validate(child, childSchema, at === "" ? key : `${at}.${key}`);
		}
	} else {
		schema.leaf(value, at);
	}
}

/** Apply defaults over a validated config. Absent fields take the product default. */
export function resolveBuildConfig(config: MaligatorBuildConfig): ResolvedBuildConfig {
	return {
		entry: config.entry,
		engine: {
			eval: config.engine?.eval ?? false,
			intl: {
				enabled: config.engine?.intl?.enabled ?? false,
				languages: config.engine?.intl?.languages ?? [],
			},
		},
		host: { scheduler: config.host?.scheduler ?? "single" },
		surface: {
			webPlatform: config.surface?.webPlatform ?? false,
			node: config.surface?.node ?? false,
			maligator: config.surface?.maligator ?? true,
		},
	};
}

/**
 * The compile-time half of `engine.eval: false` enforcement (the runtime gate in
 * builtin_eval.c is the other). Given the statically-detected dynamic-code uses
 * (from `collectDisallowedEvalUsage`), throw a {@link BuildConfigError} pointing at
 * each site and the config knob to flip. A no-op when eval is enabled or nothing
 * was found.
 */
export function assertEvalPolicy(
	config: ResolvedBuildConfig,
	usages: Array<DisallowedEvalUsage>,
): void {
	if (config.engine.eval || usages.length === 0) {
		return;
	}
	const sites = usages
		.map((u) => {
			const call = u.kind === "eval" ? "eval(...)" : "new Function(...)";
			return `  ${call} at ${u.path}:${u.line}:${u.column}`;
		})
		.join("\n");
	throw new BuildConfigError(
		`eval is disabled by your build config (engine.eval is false):\n${sites}\n` +
			`Enable it with { "engine": { "eval": true } } in maligator.build.json to use eval / new Function.`,
	);
}

const DEFAULT_CONFIG_NAME = "maligator.build.json";

/**
 * Load and resolve the build config. With `configPath`, that file must exist;
 * otherwise `maligator.build.json` in `cwd` is used if present. When no config
 * exists at all, the product defaults apply (eval OFF). Throws
 * {@link BuildConfigError} on a missing explicit path, invalid JSON, an unknown
 * key, or a wrong value type.
 */
export function loadBuildConfig(
	configPath?: string,
	cwd: string = process.cwd(),
): ResolvedBuildConfig {
	let resolvedPath: string | undefined;
	if (configPath !== undefined) {
		resolvedPath = path.resolve(cwd, configPath);
		if (!existsSync(resolvedPath)) {
			throw new BuildConfigError(`config file not found: ${resolvedPath}`);
		}
	} else {
		const candidate = path.join(cwd, DEFAULT_CONFIG_NAME);
		if (existsSync(candidate)) {
			resolvedPath = candidate;
		}
	}

	if (resolvedPath === undefined) {
		return resolveBuildConfig({});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(resolvedPath, "utf-8"));
	} catch (error) {
		throw new BuildConfigError(
			`maligator.build.json: invalid JSON in ${resolvedPath}: ${(error as Error).message}`,
		);
	}

	validate(parsed, CONFIG_SCHEMA, "");
	return resolveBuildConfig(parsed as MaligatorBuildConfig);
}

/** The normalized (deduped + sorted) selected locale set — stable hash input. */
function normalizedLocales(config: ResolvedBuildConfig): Array<string> {
	return [...new Set(config.engine.intl.languages)].sort();
}

function shortHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8);
}

/**
 * A short stable hash of the build-affecting projection of the config, used as the
 * C build-directory suffix (build-flags.ts) so binaries built under different
 * capabilities do not clobber each other's cached archives. The C archive depends
 * on `engine.eval` (flips `-DMAL_EVAL` + whether the 1.6 MB compiler is embedded)
 * and `engine.intl` (flips `-DMAL_INTL` + the locale-sensitive fallbacks).
 * Purely-frontend or not-yet-wired fields (surface, host) are excluded so unrelated
 * edits do not needlessly invalidate the cache. Returns "" for the canonical build
 * (eval on, Intl on, all locales) so it keeps the unsuffixed build dir.
 */
export function buildConfigCacheSuffix(config: ResolvedBuildConfig): string {
	// The C archive depends on eval + whether Intl is on, but NOT on the locale set
	// (that only changes the Rust/ICU datagen). Keying on locales here would spawn
	// redundant identical C build dirs.
	if (config.engine.eval && config.engine.intl.enabled) {
		return "";
	}
	return shortHash({ eval: config.engine.eval, intl: config.engine.intl.enabled });
}

/**
 * The Rust (ICU4X) archive's cache suffix. It depends ONLY on the Intl axis
 * (whether ICU is compiled + which locales are baked), NOT on `engine.eval` — so
 * toggling eval does not trigger a multi-minute ICU rebuild. "" for the canonical
 * Intl-on/all-locales archive.
 */
export function rustConfigCacheSuffix(config: ResolvedBuildConfig): string {
	const locales = normalizedLocales(config);
	if (config.engine.intl.enabled && locales.length === 0) {
		return "";
	}
	return shortHash({ intl: config.engine.intl.enabled, locales });
}
