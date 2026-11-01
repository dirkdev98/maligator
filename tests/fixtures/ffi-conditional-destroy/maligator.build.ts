// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	surface: { node: false, webPlatform: false },
	ffi: { release: { contract: "release.ffi.ts" } },
};
