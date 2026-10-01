import { resolveBuildConfig } from "../src/build-config.ts";
import type { RuntimeGapFeature } from "./runtime-gap-catalog.ts";

export function runtimeGapBuildConfig(
	features: ReadonlyArray<RuntimeGapFeature> = [],
	resolveConfig: typeof resolveBuildConfig = resolveBuildConfig,
) {
	const collator = features.includes("intl-collator");
	return resolveConfig({
		engine: {
			eval: false,
			realms: false,
			regexp: features.includes("regexp"),
			intl: { enabled: collator, features: collator ? ["collator"] : [] },
		},
		surface: { node: true, webPlatform: false, maligator: true },
	});
}
