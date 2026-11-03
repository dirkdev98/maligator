// oxlint-disable-next-line import/no-default-export -- Configuration fixture.
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	surface: { node: false, webPlatform: true },
	ffi: { arrays: { contract: "arrays.ffi.ts" } },
};
