import { BuildConfigError } from "./build-config-error.ts";
import type {
	AssetInclusion,
	MaligatorBuildConfig,
	MaligatorFfiLibrary,
} from "./public-api.d.ts";

/**
 * An entry native code calls instead of the function object: the C symbol takes the
 * VM and `arity` boxed arguments and returns the result, leaving a throw pending.
 */
export interface FfiDirectEntry {
	readonly symbol: string;
	readonly arity: number;
	/** Argument conversion or a reachable C callback can enter JavaScript. */
	readonly callsUserCode: boolean;
	/** The result every normal completion produces, when it is a primitive. */
	readonly result?: FfiDirectResult;
	/**
	 * Struct arguments, which the binding reads before the C call and never keeps, with
	 * the struct's field names in order. A caller may lend storage it reuses afterwards.
	 */
	readonly borrows?: ReadonlyArray<FfiDirectBorrow>;
	/**
	 * For a struct result, its field names in order: the binding also has an entry, named
	 * by `ffiIntoSymbol`, that writes the fields into a compiled caller's stack object
	 * instead of creating the object. It takes the arguments, then the stack object and
	 * its field slots.
	 */
	readonly into?: { readonly fields: ReadonlyArray<string> };
}

/** The entry of a binding that writes a struct result into a caller's stack object. */
export function ffiIntoSymbol(directSymbol: string): string {
	return directSymbol.replace(/^mal_ffi_direct/, "mal_ffi_into");
}

export interface FfiDirectBorrow {
	readonly argument: number;
	readonly fields: ReadonlyArray<string>;
}

/** A binding's primitive result; integers come from a C type, so their range is exact. */
export type FfiDirectResult =
	| { readonly kind: "integer"; readonly minimum: number; readonly maximum: number }
	| { readonly kind: "number" }
	| { readonly kind: "boolean" }
	| { readonly kind: "bigint" }
	| { readonly kind: "undefined" };

/** The host module a configured C library provides as `maligator:ffi/<name>`. */
export interface FfiModule {
	readonly id: string;
	readonly exports: ReadonlyArray<string>;
	readonly installer: string;
	/** Direct entries of the function exports, by export name. */
	readonly direct: Readonly<Record<string, FfiDirectEntry>>;
}

export interface ResolvedBuildConfig {
	entry: string | undefined;
	outputName: string | undefined;
	assets: Record<string, AssetInclusion>;
	modules: { aliases: Record<string, string> };
	engine: {
		primordials: "locked" | "mutable";
		eval: boolean | "compile-check";
		realms: boolean;
		regexp: boolean;
		temporal: boolean;
		intl: { enabled: boolean; features: Array<string>; languages: Array<string> };
	};
	surface: { webPlatform: boolean; node: boolean; maligator: boolean };
	ffi: Record<string, MaligatorFfiLibrary>;
	/** Derived from the libraries' headers before compilation; empty until then. */
	ffiModules: ReadonlyArray<FfiModule>;
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
		modules: { aliases: { ...(config.modules?.aliases ?? {}) } },
		engine: {
			primordials: config.engine?.primordials ?? "locked",
			eval: config.engine?.eval ?? false,
			realms: config.engine?.realms ?? false,
			// RegExp is core ECMAScript, so it defaults ON (unlike eval/Intl/web) —
			// power users disable it explicitly for size-critical builds.
			regexp: config.engine?.regexp ?? true,
			// Temporal carries calendar and time-zone data, so product builds opt in.
			temporal: config.engine?.temporal ?? false,
			intl: {
				enabled: config.engine?.intl?.enabled ?? false,
				features: config.engine?.intl?.features ?? [],
				languages: config.engine?.intl?.languages ?? [],
			},
		},
		surface: {
			webPlatform: config.surface?.webPlatform ?? false,
			node: config.surface?.node ?? false,
			maligator: config.surface?.maligator ?? true,
		},
		ffi: { ...(config.ffi ?? {}) },
		ffiModules: [],
	};
}
