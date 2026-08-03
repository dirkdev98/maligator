import type { MaligatorBuildConfig } from "./public-api.d.ts";

export type {
	AssetInclusion,
	MaligatorAssets,
	MaligatorBuildConfig,
	MaligatorIntlFeature,
	MaligatorMaterializeOptions,
	MaligatorRuntime,
	MaligatorServeOptions,
	MaligatorServer,
	MaligatorWebRuntime,
} from "./public-api.d.ts";

export function defineBuild<const Config extends MaligatorBuildConfig>(
	config: Config,
): Config {
	return config;
}
