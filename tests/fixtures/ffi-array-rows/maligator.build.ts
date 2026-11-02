// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	surface: { webPlatform: true },
	ffi: { array_rows: { contract: "rows.ffi.ts" } },
};
