/* oxlint-disable import/no-default-export, typescript/no-unsafe-call -- The build config loader requires this published-package shape. */
// @ts-expect-error -- The product config loader supplies this published-package import.
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "website/server.mts",
	outputName: "maligator-site",
	modules: {
		aliases: {
			// The container image serves documentation built for its own base URL.
			"maligator-site:documentation": `${process.cwd()}/.cache/documentation/${process.env.MALIGATOR_SITE_CONTAINER === "1" ? "container" : "plain"}`,
		},
	},
	engine: {
		eval: false,
		realms: false,
		regexp: false,
		temporal: false,
		intl: { enabled: false },
	},
});
