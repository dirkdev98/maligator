import { resolveBuildConfig } from "../src/build-config.ts";
import type { RuntimeGapFeature } from "./runtime-gap-catalog.ts";

export function runtimeGapBuildConfig(
	features: ReadonlyArray<RuntimeGapFeature> = [],
	resolveConfig: typeof resolveBuildConfig = resolveBuildConfig,
) {
	const collator = features.includes("intl-collator");
	const listFormat = features.includes("intl-list-format");
	return resolveConfig({
		engine: {
			eval: false,
			realms: false,
			regexp: features.includes("regexp"),
			intl: {
				enabled: collator || listFormat,
				features: [
					...(collator ? (["collator"] as const) : []),
					...(listFormat ? (["list-format"] as const) : []),
				],
			},
		},
		surface: { node: true, webPlatform: false, maligator: true },
	});
}
