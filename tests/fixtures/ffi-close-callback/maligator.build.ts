// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "main.ts",
	engine: { eval: true, realms: true, primordials: "mutable" },

	ffi: { close: { contract: "close.ffi.ts" } },
};
