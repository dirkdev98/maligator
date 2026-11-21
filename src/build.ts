import type { MaligatorBuildConfig, MaligatorLibraryContract } from "./public-api.d.ts";

export type {
	MaligatorBuildConfig,
	MaligatorFfiCallback,
	MaligatorFfiCount,
	MaligatorFfiFind,
	MaligatorFfiFunctionFacts,
	MaligatorFfiHandle,
	MaligatorFfiLibrary,
	MaligatorFfiShape,
	MaligatorFfiTypeFacts,
	MaligatorFfiValueFacts,
	MaligatorFfiVariant,
	MaligatorIntlFeature,
	MaligatorLibraryContract,
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
