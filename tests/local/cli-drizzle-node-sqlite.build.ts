/* oxlint-disable import/no-default-export -- Build configs require a default export. */

export default {
	entry: "tests/local/drizzle-node-sqlite.mjs",
	outputName: "cli-drizzle-node-sqlite",
	surface: {
		node: true,
	},
};
