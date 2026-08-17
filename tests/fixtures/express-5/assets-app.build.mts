/* eslint-disable import-x/no-default-export -- Build configs require a default export. */

export default {
	entry: "tests/fixtures/express-5/assets-smoke.cjs",
	outputName: "express-assets-real-world",
	assets: {
		public: {
			type: "directory",
			path: "tests/fixtures/express-5/public",
			include: ["**/*"],
		},
	},
	engine: { primordials: "mutable", intl: { enabled: false } },
	surface: { webPlatform: true, node: true, maligator: true },
};
