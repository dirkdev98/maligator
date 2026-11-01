// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: false, realms: false },
	surface: { webPlatform: true, node: false },
	ffi: { text: { contract: "text.ffi.ts" } },
};
