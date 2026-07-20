import { hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ESTree } from "meriyah";
import { INTL_SERVICE_FEATURES, normalizeNativeFeatures } from "./build-flags.ts";
import type { NativeFeatureSpec } from "./build-flags.ts";
import { defineBuild as defineBuildIdentity } from "./build.ts";
import { stripCompactTypes } from "./compact-type-strip.ts";
import { parseModule } from "./parser.ts";
import type { DisallowedEvalUsage, DisallowedRegexpUsage } from "./semantic-analysis.ts";

/**
 * The `maligator.build.ts` build configuration (GitHub issue #2). The file is
 * the source of truth for engine capabilities, host execution mode, and the API
 * surface exposed to user code. The resolved configuration controls native feature
 * selection and host-module policy; unsupported combinations are rejected before
 * compilation.
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
	outputName?: string;
	assets?: Record<string, AssetInclusion>;
	engine?: {
		eval?: boolean;
		/** The Realm surface (Realm global / callable boundary). Defaults OFF. */
		realms?: boolean;
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

export type AssetInclusion =
	| { type: "file"; path: string }
	| { type: "directory"; path: string; include: Array<string> };

/** A build config with every default applied — what the compiler consumes. */
export interface ResolvedBuildConfig {
	entry: string | undefined;
	outputName: string | undefined;
	assets: Record<string, AssetInclusion>;
	engine: {
		eval: boolean;
		realms: boolean;
		regexp: boolean;
		intl: { enabled: boolean; features: Array<string>; languages: Array<string> };
	};
	host: { scheduler: "single" | "multiprocessing" };
	surface: { webPlatform: boolean; node: boolean; maligator: boolean };
}

/** Thrown for a malformed / mistyped `maligator.build.ts`, with a clear reason. */
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
export const INTL_SERVICES = INTL_SERVICE_FEATURES;

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
		throw new BuildConfigError(`maligator.build.ts: '${at}' must be ${expected}`);
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

const assetsLeaf: Leaf = {
	leaf: (value, at) => {
		expect(
			typeof value === "object" && value !== null && !Array.isArray(value),
			at,
			"an object",
		);
		for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
			const entryAt = `${at}.${name}`;
			expect(name.length > 0 && !name.includes("\0"), entryAt, "a non-empty asset name");
			expect(
				typeof entry === "object" && entry !== null && !Array.isArray(entry),
				entryAt,
				"an object",
			);
			const object = entry as Record<string, unknown>;
			for (const key of Object.keys(object)) {
				if (key !== "type" && key !== "path" && key !== "include") {
					throw new BuildConfigError(
						`maligator.build.ts: unknown key '${entryAt}.${key}' (allowed: type, path, include)`,
					);
				}
			}
			expect(
				object.type === "file" || object.type === "directory",
				`${entryAt}.type`,
				`"file" or "directory"`,
			);
			expect(
				typeof object.path === "string" && object.path.length > 0,
				`${entryAt}.path`,
				"a non-empty string",
			);
			if (object.type === "directory") {
				expect(
					Array.isArray(object.include) &&
						object.include.length > 0 &&
						object.include.every((item) => typeof item === "string"),
					`${entryAt}.include`,
					"a non-empty array of strings",
				);
			} else if (object.include !== undefined) {
				throw new BuildConfigError(
					`maligator.build.ts: '${entryAt}.include' is only valid for directory assets`,
				);
			}
		}
	},
};

const CONFIG_SCHEMA: ObjectSchema = {
	object: {
		entry: stringLeaf,
		outputName: stringLeaf,
		assets: assetsLeaf,
		engine: {
			object: {
				eval: booleanLeaf,
				realms: booleanLeaf,
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
					`maligator.build.ts: unknown key '${at === "" ? key : `${at}.${key}`}' (allowed: ${allowed})`,
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
	if (
		Object.keys(config.assets ?? {}).length > 0 &&
		config.surface?.maligator === false
	) {
		throw new BuildConfigError(
			"maligator.build.ts: configured assets require surface.maligator to be enabled",
		);
	}
	return {
		entry: config.entry,
		outputName: config.outputName,
		assets: { ...(config.assets ?? {}) },
		engine: {
			eval: config.engine?.eval ?? false,
			realms: config.engine?.realms ?? false,
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
			`Enable it with { engine: { eval: true } } in maligator.build.ts to use eval / new Function.`,
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
			`Remove { engine: { regexp: false } } from maligator.build.ts to use RegExp (it is on by default).`,
	);
}

const DEFAULT_CONFIG_NAME = "maligator.build.ts";

export type BuildConfigTypeStripper = (source: string, filePath: string) => string;

function sourceOffset(
	source: string,
	location: { line: number; column: number },
): number {
	let line = 1;
	let offset = 0;
	while (line < location.line) {
		const newline = source.indexOf("\n", offset);
		if (newline < 0) {
			return source.length;
		}
		offset = newline + 1;
		line++;
	}
	return offset + location.column;
}

function overwritePreservingLines(
	output: Array<string>,
	start: number,
	end: number,
	replacement = "",
): void {
	let replacementIndex = 0;
	for (let index = start; index < end; index++) {
		if (output[index] === "\n" || output[index] === "\r") {
			continue;
		}
		output[index] = replacement[replacementIndex++] ?? " ";
	}
	if (replacementIndex < replacement.length) {
		throw new BuildConfigError("maligator.build.ts: unsupported default export layout");
	}
}

function configStatementRange(
	source: string,
	statement: ESTree.Node,
): { start: number; end: number } {
	if (statement.loc === undefined || statement.loc === null) {
		throw new BuildConfigError("maligator.build.ts: parser omitted source locations");
	}
	return {
		start: sourceOffset(source, statement.loc.start),
		end: sourceOffset(source, statement.loc.end),
	};
}

function evaluateBuildConfig(
	source: string,
	configPath: string,
	stripTypes: BuildConfigTypeStripper,
): unknown {
	let stripped: string;
	let ast: ESTree.Program;
	try {
		stripped = stripTypes(source, configPath);
		ast = parseModule(stripped).ast;
	} catch (error) {
		throw new BuildConfigError(
			`maligator.build.ts: cannot parse ${configPath}: ${(error as Error).message}`,
		);
	}

	if (stripped.includes("$cfg")) {
		throw new BuildConfigError(
			"maligator.build.ts: '$cfg' is reserved by the configuration loader",
		);
	}

	const output = stripped.split("");
	let defaultExport: ESTree.ExportDefaultDeclaration | undefined;
	for (const statement of ast.body) {
		if (statement.type === "ImportDeclaration") {
			const validImport =
				statement.source.value === "maligator" &&
				statement.specifiers.length === 1 &&
				statement.specifiers[0]?.type === "ImportSpecifier" &&
				statement.specifiers[0].imported.type === "Identifier" &&
				statement.specifiers[0].imported.name === "defineBuild" &&
				statement.specifiers[0].local.name === "defineBuild";
			if (!validImport) {
				throw new BuildConfigError(
					'maligator.build.ts: only `import { defineBuild } from "maligator"` is supported',
				);
			}
			const range = configStatementRange(stripped, statement);
			overwritePreservingLines(output, range.start, range.end);
			continue;
		}
		if (statement.type === "ExportDefaultDeclaration") {
			if (defaultExport !== undefined) {
				throw new BuildConfigError("maligator.build.ts: multiple default exports");
			}
			if (
				statement.declaration.type === "FunctionDeclaration" ||
				statement.declaration.type === "ClassDeclaration"
			) {
				throw new BuildConfigError(
					"maligator.build.ts: the default export must be a configuration value",
				);
			}
			defaultExport = statement;
			const statementRange = configStatementRange(stripped, statement);
			const declarationRange = configStatementRange(stripped, statement.declaration);
			overwritePreservingLines(
				output,
				statementRange.start,
				declarationRange.start,
				"$cfg=",
			);
			continue;
		}
		if (statement.type.startsWith("Export")) {
			throw new BuildConfigError(
				"maligator.build.ts: only a default configuration export is supported",
			);
		}
	}

	if (defaultExport === undefined) {
		throw new BuildConfigError("maligator.build.ts: missing default export");
	}

	let $cfg: unknown;
	const defineBuild = defineBuildIdentity;
	void defineBuild;
	try {
		// Direct eval gives trusted project configuration ordinary JS control flow and
		// access to the CLI's host globals without a compile/link subprocess.
		eval(`${output.join("")}\n//# sourceURL=${configPath}`);
	} catch (error) {
		const detail = (error as Error).stack ?? (error as Error).message;
		throw new BuildConfigError(
			`maligator.build.ts: evaluation failed in ${configPath}:\n${detail}`,
		);
	}
	return $cfg;
}

/**
 * Load and resolve the build config. With `configPath`, that file must exist;
 * otherwise `maligator.build.ts` in `cwd` is used if present. When no config
 * exists at all, the product defaults apply (eval OFF). Throws
 * {@link BuildConfigError} on a missing explicit path, invalid source, an unknown
 * key, or a wrong value type. The compact stripper default keeps this loader
 * self-hostable; the Node CLI supplies its full blank-space stripper.
 */
export function loadBuildConfig(
	configPath?: string,
	cwd: string = process.cwd(),
	stripTypes: BuildConfigTypeStripper = stripCompactTypes,
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

	const parsed = evaluateBuildConfig(
		readFileSync(resolvedPath, "utf-8"),
		resolvedPath,
		stripTypes,
	);
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

function assertSafeOutputName(name: string, source: string): string {
	if (
		name.length === 0 ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0")
	) {
		throw new BuildConfigError(
			`${source} must be a non-empty binary name without path separators`,
		);
	}
	return name;
}

export function resolveOutputName(
	config: ResolvedBuildConfig,
	cwd: string = process.cwd(),
): string {
	if (config.outputName !== undefined) {
		return assertSafeOutputName(config.outputName, "maligator.build.ts: 'outputName'");
	}

	const packagePath = path.join(cwd, "package.json");
	if (existsSync(packagePath)) {
		let packageJson: unknown;
		try {
			packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
		} catch (error) {
			throw new BuildConfigError(
				`cannot read package name from ${packagePath}: ${(error as Error).message}`,
			);
		}
		if (
			typeof packageJson === "object" &&
			packageJson !== null &&
			typeof (packageJson as { name?: unknown }).name === "string"
		) {
			const packageName = (packageJson as { name: string }).name;
			const unscopedName = packageName.slice(packageName.lastIndexOf("/") + 1);
			return assertSafeOutputName(unscopedName, "package.json#name");
		}
	}

	return assertSafeOutputName(path.basename(path.resolve(cwd)), "working directory name");
}

function shortHash(value: unknown): string {
	// One-shot node:crypto.hash (not createHash) so the compiler dogfoods the same
	// native `hash` export the node surface ships — byte-identical to the streaming
	// digest (see the build-cache parity test). SHA-256 of the JSON, first 8 hex.
	return hash("sha256", JSON.stringify(value), "hex").slice(0, 8);
}

/**
 * A short stable hash of the build-affecting projection of the config, used as the
 * output-name suffix (build-flags.ts) so binaries built under different
 * capabilities do not clobber each other. Native archives are content-addressed
 * from their exact inputs. The output depends
 * on `engine.eval` (flips `-DMAL_EVAL` + whether the compiler wire is embedded),
 * `engine.intl` (flips `-DMAL_INTL` + the locale-sensitive fallbacks),
 * `surface.webPlatform` (flips `-DMAL_WEB_PLATFORM` + whether web_url.c compiles), and
 * `surface.node` (flips `-DMAL_NODE` + the node host built-in surface). Not-yet-wired
 * fields (host.scheduler) are excluded so unrelated edits do not change the name.
 * Returns "" for the canonical build (eval on, Intl on, all
 * locales, web on, node OFF) so it keeps the unsuffixed binary name — node defaults
 * off and every internal-tooling build is node-off, so node-off stays canonical.
 */
export function buildConfigCacheSuffix(config: ResolvedBuildConfig): string {
	// The generated binary depends on eval, whether Intl is on, which services are selected
	// (each flips a -DMAL_INTL_HAS_* define), web-platform (web_url.c gating), regexp
	// (builtin_regexp/regexp_object/gc/string gating), and node (the host built-in
	// surface), but NOT on the locale set (that only changes Rust/ICU datagen).
	// Empty services = all; eval + realms + Intl + all-services + web + regexp on and
	// node off = canonical.
	const services = selectedIntlServices(config).sort();
	const web = config.surface.webPlatform;
	const regexp = config.engine.regexp;
	const node = config.surface.node;
	const realms = config.engine.realms;
	if (
		config.engine.eval &&
		realms &&
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
		realms,
	});
}

/**
 * The build inputs a resolved config maps to: one normalized feature specification
 * shared by C and Rust, plus a human-facing output suffix. This is the single
 * config → {@link LocalBuildOptions} projection shared by the CLI command layer, the
 * native test harness, and the size bench, so all three build the exact same
 * archives for a given config.
 */
export interface BuildDerivation {
	/** Canonical native backend feature specification. */
	features: NativeFeatureSpec;
	/** Human-facing binary filename decoration; not part of native artifact identity. */
	cacheSuffix: string;
}

/** Project a resolved config onto the {@link BuildDerivation} the build layer consumes. */
export function buildDerivationFromConfig(config: ResolvedBuildConfig): BuildDerivation {
	const intlFeatures = intlCargoFeatures(config);
	const intlServiceDefines = intlDisabledDefines(config);
	const features = normalizeNativeFeatures({
		evalEnabled: config.engine.eval,
		realmsEnabled: config.engine.realms,
		intlEnabled: config.engine.intl.enabled,
		intlServiceDefines,
		intlFeatures,
		webPlatformEnabled: config.surface.webPlatform,
		regexpEnabled: config.engine.regexp,
		nodeEnabled: config.surface.node,
	});
	return {
		features,
		cacheSuffix: buildConfigCacheSuffix(config),
	};
}
