/* oxlint-disable import/no-default-export -- Build configs require a default export. */

export default {
	entry: "tests/fixtures/express-5/valibot-build.mjs",
	outputName: "express-valibot-issue-4",
	engine: {
		eval: true,
	},
	surface: {
		node: true,
	},
};
