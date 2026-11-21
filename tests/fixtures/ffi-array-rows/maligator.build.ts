// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },

	ffi: { array_rows: { contract: "rows.ffi.ts" } },
};
