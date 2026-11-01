// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true },
	surface: { webPlatform: true, node: true },
	ffi: {
		managed: { contract: "state.ffi.ts" },
		zlib: { contract: "zlib.ffi.ts", link: "shared" },
	},
};
