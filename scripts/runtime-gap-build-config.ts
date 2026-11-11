import { resolveBuildConfig } from "../src/build-config.ts";
import type { RuntimeGapFeature } from "./runtime-gap-catalog.ts";

export function runtimeGapBuildConfig(
	features: ReadonlyArray<RuntimeGapFeature> = [],
	resolveConfig: typeof resolveBuildConfig = resolveBuildConfig,
) {
	const collator = features.includes("intl-collator");
	const listFormat = features.includes("intl-list-format");
	const relativeTime = features.includes("intl-relative-time-format");
	const duration = features.includes("intl-duration-format");
	const number = features.includes("intl-number-format");
	return resolveConfig({
		engine: {
			eval: false,
			realms: false,
			regexp: features.includes("regexp"),
			intl: {
				enabled: collator || listFormat || relativeTime || duration || number,
				features: [
					...(collator ? (["collator"] as const) : []),
					...(listFormat ? (["list-format"] as const) : []),
					...(relativeTime ? (["relative-time-format"] as const) : []),
					...(duration ? (["duration-format"] as const) : []),
					...(number ? (["number-format"] as const) : []),
				],
			},
		},
		surface: { node: true, webPlatform: false, maligator: true },
	});
}
