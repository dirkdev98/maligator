/* oxlint-disable import/no-default-export -- Build configs require a default export. */

export default {
	entry: "tests/fixtures/express-5/combined-dependency-build.mjs",
	outputName: "express-valibot-drizzle-issue-12",
	surface: {
		node: true,
	},
};
