import { hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { DisallowedEvalUsage, DisallowedRegexpUsage } from "./semantic-analysis.ts";

/**
 * The `maligator.build.json` build configuration (GitHub issue #2). The file is
 * the source of truth for engine capabilities, host execution mode, and the API
 * surface exposed to user code. Only `engine.eval` is acted on today; the rest of
 * the shape is parsed and validated (so the format is stable and typos are caught)
 * but does not yet change compilation.
 *
 * Every field is optional in the file — {@link resolveBuildConfig} fills defaults.
 * Defaults are deliberately conservative (the "product" defaults): eval OFF, Intl
 * OFF, web platform OFF, single-threaded scheduler, only the Maligator surface. The
 * one exception is RegExp, which is core ECMAScript and so defaults ON (power users
 * disable it explicitly). Internal tooling (the native test harness, the eval
 * self-host scripts, the test262 runner) opts back in explicitly.
 */
export interface MaligatorBuildConfig {
	entry?: string;
	engine?: {
		eval?: boolean;
		/** WHATWG RegExp (the regress engine). Core language, so defaults ON. */
		regexp?: boolean;
		intl?: {
			enabled?: boolean;
			/** Selected ECMA-402 services (see INTL_SERVICES); omitted/[] = all. */
			features?: Array<string>;
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
		regexp: boolean;
		intl: { enabled: boolean; features: Array<string>; languages: Array<string> };
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
 * The selectable Intl services (engine.intl.features), each mapped to its Rust
 * Cargo feature and C build define. Intl.Locale / getCanonicalLocales are the
 * always-on floor and are not listed. An omitted / empty `features` list means ALL
 * services (the canonical `intl-full` build). Selecting a subset drops the rest's
 * icu sub-crate + baked data — Segmenter alone is ~12 MB.
 */
export const INTL_SERVICES: Record<string, { cargo: string; define: string }> = {
	collator: { cargo: "intl-collator", define: "MAL_INTL_HAS_COLLATOR" },
	"number-format": { cargo: "intl-number-format", define: "MAL_INTL_HAS_NUMBER_FORMAT" },
	"date-time-format": {
		cargo: "intl-date-time-format",
		define: "MAL_INTL_HAS_DATE_TIME_FORMAT",
	},
	"plural-rules": { cargo: "intl-plural-rules", define: "MAL_INTL_HAS_PLURAL_RULES" },
	"list-format": { cargo: "intl-list-format", define: "MAL_INTL_HAS_LIST_FORMAT" },
	segmenter: { cargo: "intl-segmenter", define: "MAL_INTL_HAS_SEGMENTER" },
	"display-names": { cargo: "intl-display-names", define: "MAL_INTL_HAS_DISPLAY_NAMES" },
	"relative-time-format": {
		cargo: "intl-relative-time-format",
		define: "MAL_INTL_HAS_RELATIVE_TIME_FORMAT",
	},
	"duration-format": {
		cargo: "intl-duration-format",
		define: "MAL_INTL_HAS_DURATION_FORMAT",
	},
};

/** Deduped selected Intl services; [] means all services (the default). */
function selectedIntlServices(config: ResolvedBuildConfig): Array<string> {
	return [...new Set(config.engine.intl.features)];
}

/**
 * Rust Cargo features selecting the Intl build. Empty when Intl is off (the caller
 * passes --no-default-features) or all services are selected (the default
 * `intl-full` build). A subset returns the per-service features, built with
 * --no-default-features.
 */
export function intlCargoFeatures(config: ResolvedBuildConfig): Array<string> {
	if (!config.engine.intl.enabled) {
		return [];
	}
	return selectedIntlServices(config).map((name) => INTL_SERVICES[name]!.cargo);
}

/**
 * C `-D…=0` defines disabling each UNSELECTED Intl service on a subset build. Empty
 * when Intl is off (`-DMAL_INTL=0` covers everything) or all services are selected.
 */
export function intlDisabledDefines(config: ResolvedBuildConfig): Array<string> {
	if (!config.engine.intl.enabled) {
		return [];
	}
	const selected = new Set(selectedIntlServices(config));
	if (selected.size === 0) {
		return [];
	}
	return Object.entries(INTL_SERVICES)
		.filter(([name]) => !selected.has(name))
		.map(([, service]) => `-D${service.define}=0`);
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
				regexp: booleanLeaf,
				intl: {
					object: {
						enabled: booleanLeaf,
						features: stringArrayLeaf,
						languages: stringArrayLeaf,
					},
				},
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
			// RegExp is core ECMAScript, so it defaults ON (unlike eval/Intl/web) —
			// power users disable it explicitly for size-critical builds.
			regexp: config.engine?.regexp ?? true,
			intl: {
				enabled: config.engine?.intl?.enabled ?? false,
				features: config.engine?.intl?.features ?? [],
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

/**
 * The compile-time half of `engine.regexp: false` enforcement (the runtime gate —
 * the RegExp intrinsic simply not being installed — is the other). Given the
 * statically-detected RegExp uses (from `collectDisallowedRegexpUsage`), throw a
 * {@link BuildConfigError} pointing at each site and the config knob. A no-op when
 * regexp is enabled (the default) or nothing was found.
 */
export function assertRegexpPolicy(
	config: ResolvedBuildConfig,
	usages: Array<DisallowedRegexpUsage>,
): void {
	if (config.engine.regexp || usages.length === 0) {
		return;
	}
	const sites = usages
		.map((u) => {
			const what = u.kind === "literal" ? "regex literal /…/" : "new RegExp(...)";
			return `  ${what} at ${u.path}:${u.line}:${u.column}`;
		})
		.join("\n");
	throw new BuildConfigError(
		`RegExp is disabled by your build config (engine.regexp is false):\n${sites}\n` +
			`Remove { "engine": { "regexp": false } } from maligator.build.json to use RegExp (it is on by default).`,
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
	const config = resolveBuildConfig(parsed as MaligatorBuildConfig);

	// Reject unknown engine.intl.features service names (typo protection).
	for (const name of config.engine.intl.features) {
		if (!(name in INTL_SERVICES)) {
			throw new BuildConfigError(
				`engine.intl.features: unknown service '${name}' (allowed: ${Object.keys(INTL_SERVICES).join(", ")})`,
			);
		}
	}

	// Locale subsetting (engine.intl.languages) is not yet wired: it needs an
	// icu4x-datagen step feeding ICU4X_DATA_DIR, which is blocked on the ICU4X
	// marker-contract (`--markers all` omits the compact-decimal markers icu_decimal
	// references; `--markers-for-bin` finds none in our LTO'd staticlib). Fail loud
	// rather than silently bake ALL locales into a dir that claims to be a subset.
	if (config.engine.intl.enabled && config.engine.intl.languages.length > 0) {
		throw new BuildConfigError(
			"engine.intl.languages (locale subsetting) is not yet supported. Omit it to " +
				"include all locales, or set engine.intl.enabled: false to drop Intl entirely.",
		);
	}
	return config;
}

function shortHash(value: unknown): string {
	// One-shot node:crypto.hash (not createHash) so the compiler dogfoods the same
	// native `hash` export the node surface ships — byte-identical to the streaming
	// digest (see the build-cache parity test). SHA-256 of the JSON, first 8 hex.
	return hash("sha256", JSON.stringify(value), "hex").slice(0, 8);
}

/**
 * A short stable hash of the build-affecting projection of the config, used as the
 * C build-directory suffix (build-flags.ts) so binaries built under different
 * capabilities do not clobber each other's cached archives. The C archive depends
 * on `engine.eval` (flips `-DMAL_EVAL` + whether the 1.6 MB compiler is embedded),
 * `engine.intl` (flips `-DMAL_INTL` + the locale-sensitive fallbacks),
 * `surface.webPlatform` (flips `-DMAL_WEB_PLATFORM` + whether url.c compiles), and
 * `surface.node` (flips `-DMAL_NODE` + the node host built-in surface). Not-yet-wired
 * fields (host.scheduler) are excluded so unrelated edits do not needlessly
 * invalidate the cache. Returns "" for the canonical build (eval on, Intl on, all
 * locales, web on, node OFF) so it keeps the unsuffixed build dir — node defaults
 * off and every internal-tooling build is node-off, so node-off stays canonical.
 */
export function buildConfigCacheSuffix(config: ResolvedBuildConfig): string {
	// The C archive depends on eval, whether Intl is on, which services are selected
	// (each flips a -DMAL_INTL_HAS_* define), web-platform (url.c gating), regexp
	// (builtin_regexp/regexp_object/gc/string gating), and node (the host built-in
	// surface), but NOT on the locale set (that only changes the Rust/ICU datagen) or
	// on node in the Rust archive (node adds no Rust deps — see rustConfigCacheSuffix).
	// Empty services = all; eval + Intl + all-services + web + regexp on and node off
	// = canonical.
	const services = selectedIntlServices(config).sort();
	const web = config.surface.webPlatform;
	const regexp = config.engine.regexp;
	const node = config.surface.node;
	if (
		config.engine.eval &&
		config.engine.intl.enabled &&
		services.length === 0 &&
		web &&
		regexp &&
		!node
	) {
		return "";
	}
	return shortHash({
		eval: config.engine.eval,
		intl: config.engine.intl.enabled,
		services,
		web,
		regexp,
		node,
	});
}

/**
 * The Rust archive's cache suffix. It depends on the Intl axis (which icu
 * sub-crates + baked data compile), `surface.webPlatform` (whether the ada URL
 * parser compiles), and `engine.regexp` (whether regress compiles), but NOT on
 * `engine.eval` — so toggling eval does not trigger a multi-minute ICU rebuild. ""
 * for the canonical Intl-on / all-services / web-on / regexp-on archive.
 */
export function rustConfigCacheSuffix(config: ResolvedBuildConfig): string {
	const services = selectedIntlServices(config).sort();
	const web = config.surface.webPlatform;
	const regexp = config.engine.regexp;
	if (config.engine.intl.enabled && services.length === 0 && web && regexp) {
		return "";
	}
	return shortHash({ intl: config.engine.intl.enabled, services, web, regexp });
}

/**
 * The build inputs a resolved config maps to: the C `#if` gates (evalEnabled /
 * intlEnabled / per-service disable defines), the Rust Cargo features, and the
 * cache suffixes selecting the matching C + ICU archives. This is the single
 * config → {@link LocalBuildOptions} projection shared by the CLI (index.ts), the
 * native test harness, and the size bench, so all three build the exact same
 * archives for a given config.
 */
export interface BuildDerivation {
	evalEnabled: boolean;
	intlEnabled: boolean;
	intlServiceDefines: Array<string>;
	intlFeatures: Array<string>;
	webPlatformEnabled: boolean;
	regexpEnabled: boolean;
	/**
	 * Whether the node host built-in surface (`surface.node`) is on. Flips
	 * `-DMAL_NODE` on the C side and folds into the C archive cache suffix, but NOT
	 * the Rust one (node adds no Rust deps). Defaults off (product default).
	 */
	nodeEnabled: boolean;
	cacheSuffix: string;
	rustCacheSuffix: string;
}

/** Project a resolved config onto the {@link BuildDerivation} the build layer consumes. */
export function buildDerivationFromConfig(config: ResolvedBuildConfig): BuildDerivation {
	return {
		evalEnabled: config.engine.eval,
		intlEnabled: config.engine.intl.enabled,
		intlServiceDefines: intlDisabledDefines(config),
		intlFeatures: intlCargoFeatures(config),
		webPlatformEnabled: config.surface.webPlatform,
		regexpEnabled: config.engine.regexp,
		nodeEnabled: config.surface.node,
		cacheSuffix: buildConfigCacheSuffix(config),
		rustCacheSuffix: rustConfigCacheSuffix(config),
	};
}
