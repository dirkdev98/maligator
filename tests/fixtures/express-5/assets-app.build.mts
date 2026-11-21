/* oxlint-disable import/no-default-export -- Build configs require a default export. */

export default {
	entry: "tests/fixtures/express-5/assets-smoke.cjs",
	outputName: "express-assets-real-world",
	engine: { primordials: "mutable", intl: { enabled: false } },
};
