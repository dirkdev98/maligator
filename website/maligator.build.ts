/* eslint-disable import-x/no-default-export, @typescript-eslint/no-unsafe-call -- The build config loader requires this published-package shape. */
// @ts-expect-error -- The product config loader supplies this published-package import.
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "website/server.mts",
	outputName: "maligator-site",
	assets: {
		site: { type: "file", path: "website/index.html" },
		processApi: { type: "file", path: "website/maligator-process.html" },
		testApi: { type: "file", path: "website/maligator-test.html" },
		compatibility: { type: "file", path: "website/compatibility.html" },
		explorer: {
			type: "directory",
			path: ".cache/explorer-site/current",
			include: ["index.html", "manifest.json", "*.js", "*.css", "*.wasm.br", "*.txt"],
		},
	},
	engine: {
		eval: false,
		realms: false,
		regexp: false,
		temporal: false,
		intl: { enabled: false },
	},
	surface: { webPlatform: true, node: true, maligator: true },
});
