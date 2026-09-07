import { BuildConfigError } from "./build-config-error.ts";
import type { AssetInclusion, MaligatorBuildConfig } from "./public-api.d.ts";

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
	};
}
