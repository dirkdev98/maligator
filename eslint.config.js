import { defineConfig } from "@lightbase/eslint-config";

export default defineConfig(
	{
		prettier: false,
		disableImportOrdering: true,
	},
	{
		ignores: ["scripts/test262.json"],
	},
);
