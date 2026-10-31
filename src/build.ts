import type { MaligatorBuildConfig, MaligatorLibraryContract } from "./public-api.d.ts";

export type {
	AssetInclusion,
	MaligatorAssets,
	MaligatorBuildConfig,
	MaligatorFfiFind,
	MaligatorFfiLibrary,
	MaligatorIntlFeature,
	MaligatorLibraryContract,
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

export function defineLibrary<const Contract extends MaligatorLibraryContract>(
	contract: Contract,
): Contract {
	return contract;
}
