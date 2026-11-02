// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	surface: { webPlatform: true },
	ffi: { alignment: { contract: "alignment.ffi.ts" } },
};
