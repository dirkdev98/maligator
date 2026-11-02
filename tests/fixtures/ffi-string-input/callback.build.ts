// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "callback.ts",
	engine: { eval: false, realms: false },
	surface: { node: true, webPlatform: true },
	ffi: { input: { contract: "callback.ffi.ts" } },
};
