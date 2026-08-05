import { defineConfig } from "@lightbase/eslint-config";

export default defineConfig(
	{
		prettier: false,
		disableImportOrdering: true,
	},
	{
		ignores: [
			"tests/local",
			"tests/wpt/fixtures",
			"bench",
			// Shipped as source for the Maligator interpreter. Its adjacent .d.mts
			// owns editor types, so TypeScript's project service excludes the .mjs.
			"src/testing/runtime.mjs",
		],
	},
	{
		// CLI/dev scripts print to stdout/stderr by design — console is their output.
		files: ["scripts/**", "npm/cli/bin/**"],
		rules: { "no-console": "off" },
	},
);
