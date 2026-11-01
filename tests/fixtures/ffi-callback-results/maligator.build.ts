// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true, primordials: "mutable" },
	surface: { webPlatform: true, node: true },
	ffi: { results: { contract: "results.ffi.ts" } },
};
