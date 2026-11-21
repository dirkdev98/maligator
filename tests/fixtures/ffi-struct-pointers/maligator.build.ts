// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },

	ffi: { styles: { contract: "styles.ffi.ts" } },
};
