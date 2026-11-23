import { resolveBuildConfig } from "./build-config-values.ts";
import type { ResolvedBuildConfig } from "./build-config-values.ts";
export { resolveBuildConfig } from "./build-config-values.ts";
export type { ResolvedBuildConfig } from "./build-config-values.ts";
import { hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { BuildConfigError } from "./build-config-error.ts";
import { INTL_SERVICE_FEATURES, normalizeNativeFeatures } from "./build-flags.ts";
import type { NativeFeatureSpec, NativeHostFeatures } from "./build-flags.ts";
import { stripCompactTypes } from "./compiler/frontend/compact-type-strip.ts";
import type { BuildConfigTypeStripper, Leaf, ObjectSchema } from "./definition-module.ts";
import {
	booleanLeaf,
	evaluateDefinitionModule,
	expect,
	stringArrayLeaf,
	stringLeaf,
	stringRecordLeaf,
	validateDefinition,
} from "./definition-module.ts";
import { ffiLibrariesLeaf } from "./ffi/contract.ts";
import type { MaligatorBuildConfig } from "./public-api.d.ts";

export type { MaligatorBuildConfig } from "./public-api.d.ts";
export type { BuildConfigTypeStripper } from "./definition-module.ts";
export { BuildConfigError } from "./build-config-error.ts";
export {
	assertEvalPolicy,
	assertRegexpPolicy,
} from "./compiler/frontend/build-policy.ts";

/**
 * The selectable Intl services (engine.intl.features), each mapped to its Rust
 * Cargo feature. Intl.Locale / getCanonicalLocales are the floor every Intl program
 * gets and are not listed. An omitted / empty `features` list means ALL services.
 * A program links only the selected services it can reach.
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

const evalLeaf: Leaf = {
	leaf: (value, at) =>
		expect(
			typeof value === "boolean" || value === "compile-check",
			at,
			`a boolean or "compile-check"`,
		),
};
// `import`/`require` follow the dependency edge and `default` always matches, so a
// configured set names only the conditions a project chooses.
const EDGE_CONDITIONS = new Set(["import", "require", "default"]);
const conditionsLeaf: Leaf = {
	leaf: (value, at) =>
		expect(
			Array.isArray(value) &&
				value.every(
					(item) =>
						typeof item === "string" &&
						item.length > 0 &&
						!item.startsWith(".") &&
						!EDGE_CONDITIONS.has(item),
				),
			at,
			`an array of condition names other than "import", "require" and "default"`,
		),
};
const primordialsLeaf: Leaf = {
	leaf: (value, at) =>
		expect(value === "locked" || value === "mutable", at, `"locked" or "mutable"`),
};
const CONFIG_SCHEMA: ObjectSchema = {
	object: {
		entry: stringLeaf,
		outputName: stringLeaf,
		modules: { object: { aliases: stringRecordLeaf, conditions: conditionsLeaf } },
		engine: {
			object: {
				primordials: primordialsLeaf,
				eval: evalLeaf,
				realms: booleanLeaf,
				regexp: booleanLeaf,
				temporal: booleanLeaf,
				intl: {
					object: {
						enabled: booleanLeaf,
						features: stringArrayLeaf,
						languages: stringArrayLeaf,
					},
				},
			},
		},
		ffi: ffiLibrariesLeaf,
	},
};

const DEFAULT_CONFIG_NAME = "maligator.build.ts";

/**
 * Load and resolve the build config. With `configPath`, that file must exist;
 * otherwise `maligator.build.ts` in `cwd` is used if present. When no config
 * exists at all, the product defaults apply (eval OFF). Throws
 * {@link BuildConfigError} on a missing explicit path, invalid source, an unknown
 * key, or a wrong value type.
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

	const parsed = evaluateDefinitionModule(
		readFileSync(resolvedPath, "utf-8"),
		resolvedPath,
		{ label: DEFAULT_CONFIG_NAME, helper: "defineBuild", noun: "configuration" },
		stripTypes,
	);
	validateDefinition(parsed, CONFIG_SCHEMA, DEFAULT_CONFIG_NAME);
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
	// Exercise the native node:crypto.hash export when the compiler self-hosts.
	return hash("sha256", JSON.stringify(value), "hex").slice(0, 8);
}

/**
 * A short stable hash of the build-affecting projection of the config, used as the
 * output-name suffix (build-flags.ts) so binaries built under different
 * capabilities do not clobber each other. Native archives are content-addressed
 * from their exact inputs. The output depends on `engine.eval` (whether the eval
 * component and compiler wire are linked), `engine.intl` and `engine.temporal`
 * (which language components the program links), RegExp and the primordial and
 * realm flavours, but not on the locale set, which only changes Rust/ICU datagen.
 * Returns "" for the canonical build (eval, realms, Intl with all services, RegExp
 * and Temporal on, locked primordials) so it keeps the unsuffixed binary name.
 */
export function buildConfigCacheSuffix(config: ResolvedBuildConfig): string {
	const services = selectedIntlServices(config).sort();
	const regexp = config.engine.regexp;
	const temporal = config.engine.temporal;
	const realms = config.engine.realms;
	if (
		config.engine.eval === true &&
		realms &&
		config.engine.intl.enabled &&
		services.length === 0 &&
		regexp &&
		temporal &&
		config.engine.primordials === "locked"
	) {
		return "";
	}
	return shortHash({
		eval: config.engine.eval === true,
		intl: config.engine.intl.enabled,
		services,
		regexp,
		temporal,
		primordials: config.engine.primordials,
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

/**
 * Project the config and reached host components onto the native build inputs.
 * Native drivers that load images at run time keep the full host selection.
 */
export function buildDerivationFromConfig(
	config: ResolvedBuildConfig,
	hostFeatures: NativeHostFeatures = {},
): BuildDerivation {
	const intlFeatures = intlCargoFeatures(config);
	const features = normalizeNativeFeatures({
		primordialsLocked: config.engine.primordials === "locked",
		evalEnabled: config.engine.eval === true,
		realmsEnabled: config.engine.realms,
		intlEnabled: config.engine.intl.enabled,
		intlFeatures,
		...hostFeatures,
		regexpEnabled: config.engine.regexp,
		temporalEnabled: config.engine.temporal,
	});
	return {
		features,
		cacheSuffix: buildConfigCacheSuffix(config),
	};
}
