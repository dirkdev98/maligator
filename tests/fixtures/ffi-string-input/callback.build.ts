// oxlint-disable-next-line import/no-default-export -- configuration fixture
export default {
	entry: "callback.ts",
	engine: { eval: false, realms: false },

	ffi: { input: { contract: "callback.ffi.ts" } },
};
