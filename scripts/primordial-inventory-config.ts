import { resolveBuildConfig } from "../src/build-config.ts";
import type { MaligatorIntlFeature } from "../src/public-api.d.ts";

const intlFeatures: ReadonlyArray<MaligatorIntlFeature> = [
	"collator",
	"number-format",
	"date-time-format",
	"plural-rules",
	"list-format",
	"segmenter",
	"display-names",
	"relative-time-format",
	"duration-format",
];
export const primordialInventoryModes = [
	"minimal",
	"full",
	"mutable",
	"node",
	"web",
	"diagnostic",
	"no-eval",
	"no-realms",
	"no-regexp",
	"no-temporal",
	"no-intl",
	...intlFeatures.map((feature) => `intl-${feature}`),
];

export function primordialInventoryConfig(mode: string) {
	if (!primordialInventoryModes.includes(mode))
		throw new Error(`Unknown inventory mode ${mode}`);
	const enabled = !["minimal", "node", "web"].includes(mode);
	const selected = intlFeatures.find((feature) => mode === `intl-${feature}`);
	return resolveBuildConfig({
		engine: {
			primordials: mode === "mutable" ? "mutable" : "locked",
			eval: enabled && mode !== "no-eval",
			realms: enabled && mode !== "no-realms",
			regexp: enabled && mode !== "no-regexp",
			temporal: enabled && mode !== "no-temporal",
			intl: {
				enabled: enabled && mode !== "no-intl",
				features: selected === undefined ? [] : [selected],
			},
		},
		surface: { webPlatform: enabled || mode === "web", node: enabled || mode === "node" },
	});
}
