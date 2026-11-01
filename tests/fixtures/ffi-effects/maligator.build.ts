// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true },
	surface: { webPlatform: true, node: true },
	ffi: { math: { contract: "math.ffi.ts" } },
};
