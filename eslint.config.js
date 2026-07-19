import { defineConfig } from "@lightbase/eslint-config";

export default defineConfig(
	{
		prettier: false,
		disableImportOrdering: true,
	},
	{
		ignores: ["tests/local", "tests/wpt/fixtures", "bench"],
	},
	{
		// CLI/dev scripts print to stdout/stderr by design — console is their output.
		files: ["scripts/**"],
		rules: { "no-console": "off" },
	},
);
